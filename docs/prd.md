# PRD — Jarvis Hub: Modo de Código (IDE Visual-First)

**Autor:** John (PM) a partir do brief da Mary
**Data:** 2026-04-24
**Versão:** 0.2 — rascunho para Winston (Arquiteto)
**Fonte:** `docs/brief.md`

---

## 1. Goals e Contexto

### Goals (o que este produto precisa alcançar)

- **G1.** Permitir que um no-coder construa um app web real, exportável, sem escrever código manualmente.
- **G2.** Entregar UX de arrastar-e-conectar comparável ao Bubble.io, mas emitindo **código Next.js + Supabase** (Postgres + Auth + Storage + Realtime) legível e portável.
- **G3.** Integrar agente de IA (Claude via plano Max) que edita múltiplos arquivos do projeto a partir de instruções em linguagem natural.
- **G4.** Ser **mais barato que Bubble** para o usuário final (fase 2) e **mais acessível que Cursor/Claude Code** para o público no-coder.
- **G5.** Sustentar uma **comunidade ativa** em torno do produto, apoiada em **core open-source no GitHub**.
- **G6. (Validação fase 1)** Diogo constrói uma feature nova do próprio Jarvis Hub — **a tela de gerenciamento dos agents BMad** — usando exclusivamente o novo Modo de Código, sem escrever código à mão, em tempo **menor** do que escreveria manualmente.

### Contexto

Jarvis Hub hoje é uma aplicação Node.js + SQLite + HTML vanilla rodando localmente, com um Modo de Código que só acessa a pasta do projeto e oferece um chat simples. A evolução proposta é transformar esse Modo de Código numa **IDE visual-first** mirando no-coders ex-Bubble com três dores explícitas (preço, controle/código real, comunidade) — diferencial frente a Cursor/v0/Bolt/Lovable.

O brief define 4 camadas entregues em ordem: (1) Visual Builder, (2) Agente de Código com contexto de repo, (3) Workflows Visuais, (4) Editor completo estilo Cursor. A **fase 1** é validação em uso próprio; a **fase 2** é venda ao público no-coder.

### Change Log

| Data       | Versão | Descrição                  | Autor |
| ---------- | ------ | -------------------------- | ----- |
| 2026-04-24 | 0.1    | Rascunho inicial do PRD    | John  |
| 2026-04-24 | 0.2    | Supabase como backend padrão + MCP para o agente | John  |

---

## 2. Requisitos

### Funcionais (FR)

**Visual Builder (camada 1 — MVP da fase 1)**

- **FR1.** O usuário consegue criar um **novo projeto** a partir do Modo de Código com stack-alvo fixa **Next.js + Supabase** (Postgres gerenciado + Auth + Storage + Realtime + Edge Functions), e o sistema gera o scaffolding inicial no filesystem local, incluindo client Supabase pré-configurado e variáveis de ambiente template.
- **FR2.** O Visual Builder apresenta um **canvas** onde o usuário arrasta componentes de uma biblioteca lateral (texto, botão, input, lista, formulário, tabela, container, imagem) para montar uma página.
- **FR3.** Cada componente arrastado tem um **painel de propriedades** editável visualmente (texto, cor, tamanho, evento onClick, binding com campo de dados).
- **FR4.** O Visual Builder **gera código Next.js (App Router) + TypeScript + Tailwind** em tempo real para cada alteração no canvas, salvando nos arquivos corretos do projeto.
- **FR5.** O código gerado é **legível por humanos** — nomes de arquivo, componentes e classes seguem convenções idiomáticas de Next.js; sem marcadores proprietários, sem IDs aleatórios, sem camadas de runtime escondidas.
- **FR6.** O usuário pode **abrir qualquer arquivo gerado** num painel de leitura (editor completo vem na camada 4) e ver o que o builder produziu.
- **FR7.** O usuário consegue definir um **modelo de dados visual** (entidades, campos, tipos, relações) que é materializado em:
  - um schema **Postgres no Supabase** via migrations versionadas (arquivos `.sql` em `supabase/migrations/`),
  - um client de acesso a dados tipado (Supabase client + types gerados via `supabase gen types`, opcionalmente camada ORM como Drizzle sobre a connection string — Winston decide se vale a pena),
  - **políticas RLS (Row Level Security) padrão** geradas automaticamente para cada tabela conforme regras de acesso definidas visualmente (pública, autenticada, dono-do-registro).
- **FR8.** O usuário consegue **conectar um componente visual a um campo de dados** (ex.: lista → entidade `Agent`; formulário → criar/editar `Agent`) sem escrever código.
- **FR9.** O projeto consegue ser **executado localmente** (`npm run dev` equivalente) direto do Modo de Código, com um botão "Preview" que abre o app em iframe ou nova aba.
- **FR10.** O projeto pode ser **exportado** como repositório Git standalone, rodável fora do Jarvis Hub sem nenhuma dependência do builder. O export inclui `supabase/` (migrations + config) e instruções para (a) rodar Supabase local via CLI ou (b) apontar para projeto Supabase Cloud do usuário.

**Primitivas Supabase expostas no builder (camada 1)**

- **FR10a. Auth:** o usuário arrasta componentes "Tela de Login", "Tela de Cadastro", "Botão de Logout", e define "Tela protegida (exige login)" nas páginas — tudo materializa em código usando `@supabase/ssr` e middleware de auth padrão.
- **FR10b. Storage:** o usuário arrasta componente "Upload de Arquivo" ou "Galeria", escolhe bucket Supabase Storage, e o builder gera upload/download com policies padrão.
- **FR10c. Realtime:** em listas conectadas a entidades, o usuário pode marcar "atualizar em tempo real", e o builder adiciona subscription Supabase Realtime no componente gerado.
- **FR10d. Configuração do projeto Supabase:** na primeira execução do projeto, o builder guia o usuário para (a) rodar `supabase start` local (via CLI) ou (b) colar URL + anon key de um projeto Supabase Cloud. Credenciais ficam em `.env.local` do projeto gerado, nunca no builder.

**Agente de Código + Chat (camada 2)**

- **FR11.** O chat do Modo de Código tem contexto automático do projeto atual (estrutura de arquivos, componentes visuais, modelo de dados).
- **FR12.** O agente aceita instruções em linguagem natural ("adicione um botão de deletar em cada linha da lista de agents") e edita **múltiplos arquivos** necessários, apresentando um **diff por arquivo** antes de aplicar.
- **FR13.** O usuário pode **aceitar, rejeitar ou editar** cada diff proposto antes da aplicação.
- **FR14.** O agente **mantém sincronia com o estado visual** — se editar código que o builder conhece, o canvas reflete a mudança; se o código escapar do que o builder representa, o componente fica marcado como "custom code" e o builder não sobrescreve.
- **FR14a. Integração MCP — Supabase:** o agente se conecta ao **Supabase MCP server** do projeto ativo (credenciais do projeto Supabase do usuário) e usa como ferramentas: consultar schema real, propor migrations SQL, rodar queries de teste, inspecionar policies RLS, listar buckets de Storage, ler logs de Edge Functions. Operações destrutivas (drop, delete em massa) exigem confirmação explícita do usuário.
- **FR14b. Extensibilidade MCP:** a arquitetura do agente deve suportar adicionar **outros MCP servers** no futuro (GitHub, Stripe, Filesystem avançado, etc.) via configuração, sem refatoração. No MVP apenas o Supabase MCP está ativo.

**Workflows Visuais (camada 3)**

- **FR15.** O usuário monta fluxos visuais (trigger → passos → condicionais → saída) que geram **route handlers / server actions** do Next.js ou **Supabase Edge Functions** (Deno), conforme a natureza do fluxo — triggers de DB e jobs agendados vão para Edge Functions; fluxos síncronos ligados a UI vão para server actions.
- **FR16.** Cada workflow tem **passos nativos** (HTTP request, query Supabase, insert/update/delete em entidade, envio de email, upload para Storage, chamada a Edge Function, webhook) e **passo customizado** (trecho de código gerado pelo agente).
- **FR16a. Triggers Supabase:** fluxos podem ser disparados por eventos Supabase (insert/update/delete em tabela via Database Webhooks, ou evento de auth como `user.created`).

**Editor Completo (camada 4)**

- **FR17.** Editor de código com syntax highlight, autocomplete, e chat lateral com contexto do arquivo aberto.
- **FR18.** Edições manuais no editor **não quebram** o Visual Builder — arquivos modificados fora da representação visual são marcados como "custom".

**Feature-piloto da fase 1**

- **FR19.** Usando apenas FR1-FR10d (Visual Builder camada 1) e opcionalmente FR11-FR14b (agente), Diogo consegue construir no Jarvis Hub uma **tela de gerenciamento dos agents BMad** com as capacidades:
  - listar todos os agents (leitura dos arquivos `.md` em `bmad/agents/` ou equivalente a ser definido com Winston),
  - abrir um agent específico e ver seu prompt,
  - editar o prompt e salvar,
  - criar um novo agent,
  - excluir um agent (com confirmação).

**Comunidade & Open Source**

- **FR20.** O core do builder + runtime do código gerado é publicado em **repositório GitHub público** com licença permissiva (MIT ou Apache 2.0 — a definir).
- **FR21.** Instalação local via clone do repo funciona com no máximo 3 comandos documentados em README.

### Não-Funcionais (NFR)

- **NFR1. Performance do builder:** alterações no canvas refletem no código em ≤ 500ms no hardware local do Diogo.
- **NFR2. Performance do preview:** primeiro render do app gerado em ≤ 3s após alteração.
- **NFR3. Legibilidade do código:** qualquer dev júnior lendo o repo exportado consegue entender a estrutura sem documentação específica do builder.
- **NFR4. Portabilidade:** o app exportado roda em Vercel, Railway, Fly.io, ou VPS comum com Node ≥ 20 apontado para (a) Supabase Cloud ou (b) Supabase self-hosted, sem modificações de código — apenas troca de variáveis de ambiente.
- **NFR4a. Sem lock-in no Supabase:** código gerado usa Supabase client e Postgres padrão; migrar para Postgres gerenciado + auth próprio é possível com trabalho, mas o builder não introduz dependências proprietárias além das necessárias para usar as features Supabase (RLS, Storage, Realtime).
- **NFR5. Coexistência com Jarvis Hub atual:** o novo Modo de Código não quebra nenhuma funcionalidade existente (chat, workers, DB SQLite, puppeteer). Roda como módulo adicional dentro do `server.js` atual ou como processo filho — decisão do Winston. **Supabase é do código gerado pelo usuário**, não do Jarvis Hub: o Hub continua em Node + SQLite.
- **NFR6. Segurança do filesystem:** o builder só escreve dentro do diretório do projeto ativo; nunca fora.
- **NFR6a. Segurança das credenciais Supabase:** credenciais do Supabase do usuário (URL, anon key, service role key) ficam apenas no `.env.local` do projeto gerado e na configuração do MCP server local do agente. Nunca são enviadas ao Jarvis Hub remoto nem ao Claude — o MCP server intermedeia chamadas.
- **NFR7. Custo de IA por usuário:** todo uso de Claude na fase 1 usa a conta Max do Diogo; fase 2 exige modelo de repasse de custos a definir (fora deste PRD).
- **NFR8. Offline parcial:** Visual Builder funciona sem chamar Claude; só o agente (camada 2+) depende de rede.

---

## 3. UI / UX — Diretrizes

### Princípios

- **Familiar para ex-Bubble:** canvas central, palette lateral esquerda, properties panel lateral direito. Não reinventar a roda.
- **Código sempre visível, nunca obrigatório:** um botão/aba "ver código" mostra o arquivo gerado. O usuário pode ignorar pra sempre, mas a porta está aberta.
- **Feedback instantâneo:** toda alteração no canvas gera efeito visível em ≤ 500ms (otimismo de UI — commit no filesystem pode ser assíncrono).
- **Zero terminologia de dev na camada 1:** "componente", "tela", "dado", "ação". Nada de "prop", "state", "hook", "server action" na UI — apenas nos tooltips de "ver código".

### Estrutura de telas (camada 1)

1. **Dashboard de Projetos** — lista projetos criados, botão "novo projeto".
2. **Canvas do Projeto** — layout 3 colunas (palette | canvas | properties), aba superior para alternar entre páginas, aba lateral para modelo de dados.
3. **Visualizador de Dados** — tabela por entidade, com editor inline de registros de teste.
4. **Preview** — iframe ou nova aba com o app rodando.
5. **Export** — botão único "baixar repositório" + instruções.

### Acessibilidade

- Meta v1: WCAG AA nos componentes da biblioteca do builder (o código **gerado** pelo usuário pode ser qualquer coisa — responsabilidade dele).

---

## 4. Premissas Técnicas (input pro Winston)

*Estas premissas são o ponto de partida; Winston tem autoridade para refiná-las ou contestar.*

- **Stack-alvo do código gerado:** **Next.js 15+ (App Router) + TypeScript + Tailwind + Postgres**.
- **ORM:** Prisma ou Drizzle — Winston decide. Prisma é mais familiar; Drizzle é mais leve/portável.
- **Builder roda dentro do Jarvis Hub atual:** Node.js + `server.js`. Nova UI do builder mora em `public/builder/` ou sob nova rota. SQLite atual preservado para metadata do builder; Postgres é apenas do código gerado pelo usuário (roda em container local ou instância configurada pelo usuário).
- **Representação visual → código:** provavelmente AST ou schema intermediário (JSON) → template → arquivos. Winston projeta.
- **Agente de IA:** API da Anthropic com Claude (plano Max). Tool use para edição de arquivos. Contexto = estrutura do projeto + arquivos relevantes.
- **Open source:** core e runtime no GitHub público. Jarvis Hub completo (com dados privados do Diogo) continua privado — o repo público é só o builder/runtime.

---

## 5. Lista de Épicos

Ordem de entrega. Cada épico é um incremento deployável e testável.

**Épico 1 — Fundação: Scaffolding & Integração no Jarvis Hub**
Estabelecer a base: novo módulo de "Projetos do Builder" dentro do Jarvis Hub, criação de um projeto Next.js vazio no filesystem, botão de preview rodando `npm run dev`, estrutura de metadata (qual projeto está ativo, onde está no disco).

**Épico 2 — Visual Builder MVP (Camada 1)**
Canvas, palette de componentes básicos, properties panel, geração de código Next.js idiomático em tempo real, modelo de dados visual, binding componente ↔ dado. Entrega: um usuário arrasta componentes, define entidades, e tem um app Next.js funcional gerado.

**Épico 3 — Feature-Piloto: Gerenciador de Agents BMad (Validação Fase 1)**
Diogo usa o Épico 2 pra construir a tela de listar/editar/criar/deletar agents BMad dentro do Jarvis Hub. Este épico **não escreve código do builder** — valida o builder construindo algo real. Sucesso = feature funcionando + tempo menor que código manual.

**Épico 4 — Agente de Código com Contexto de Repo (Camada 2)**
Chat com contexto automático, edição multi-arquivo via Claude, review de diffs, sincronia com estado visual do builder.

**Épico 5 — Workflows Visuais (Camada 3)**
Editor de fluxos que gera route handlers / server actions no Next.js.

**Épico 6 — Editor Completo Estilo Cursor (Camada 4)**
Editor embutido com syntax highlight, autocomplete, chat lateral por arquivo.

**Épico 7 — Open Source Readiness & Comunidade**
Extração do core/runtime pra repo público no GitHub, README, licença, CI básico, canal da comunidade (Discord ou GitHub Discussions), documentação mínima.

---

## 6. Detalhamento dos Épicos

> Nota: detalhamento completo de stories fica com o Bob após Winston entregar a arquitetura. Aqui apenas a espinha de cada épico — objetivos, stories esperadas e critérios de aceitação do épico como um todo.

### Épico 1 — Fundação: Scaffolding & Integração

**Objetivo:** Ter, ao final, um botão "Novo Projeto Builder" no Jarvis Hub que cria um projeto Next.js em branco, o registra em metadata local, e consegue iniciar um servidor de preview em porta separada.

**Stories esperadas:**
- 1.1 — Estrutura de metadata (tabela `builder_projects` no SQLite: id, nome, path, stack, created_at).
- 1.2 — Endpoint `POST /api/builder/projects` para criar projeto: copia template Next.js → pasta escolhida → registra em SQLite.
- 1.3 — Template-base de projeto Next.js + TypeScript + Tailwind + Prisma/Drizzle (a decidir) versionado dentro do Jarvis Hub.
- 1.4 — UI inicial em `public/builder/`: tela "Meus Projetos" listando projetos, botão "Novo Projeto".
- 1.5 — Endpoint `POST /api/builder/projects/:id/preview/start` que roda `npm install` (idempotente) e `npm run dev` em porta livre, retorna URL.
- 1.6 — Parar preview ao trocar de projeto; evitar vazamento de processos.

**Critérios de aceitação do épico:**
- Criar projeto em ≤ 30s (primeira vez, com `npm install`).
- Preview sobe e fica acessível em URL local.
- Fechar aba do Jarvis Hub mata os processos de preview.

---

### Épico 2 — Visual Builder MVP

**Objetivo:** Ter um canvas funcional onde um no-coder constrói uma tela arrastando componentes, define dados e vê o código Next.js sendo gerado corretamente.

**Stories esperadas (espinha):**
- 2.1 — Representação intermediária (JSON schema) de página/componente: estrutura canônica a partir da qual o código é emitido.
- 2.2 — Palette com componentes v1: Container, Texto, Botão, Input, Form, Lista, Tabela, Imagem.
- 2.3 — Canvas com drag-and-drop, seleção, reordenação, delete.
- 2.4 — Properties panel dinâmico por tipo de componente.
- 2.5 — Gerador de código: JSON schema → `.tsx` idiomático Next.js + Tailwind. Salvamento no filesystem.
- 2.6 — Modelo de dados visual: criar entidades, campos, tipos, relações. Gerar schema Prisma/Drizzle e migration.
- 2.7 — Binding componente ↔ dado: Lista lê entidade; Form cria/edita registro.
- 2.8 — Preview ao vivo integrado (usa Épico 1.5).
- 2.9 — Export: botão "baixar .zip" do projeto inteiro.
- 2.10 — Persistência do JSON schema no projeto (arquivo `builder.json` ou equivalente na raiz do projeto gerado — decisão do Winston).

**Critérios de aceitação do épico:**
- Usuário sem conhecer Next.js monta uma tela com lista + formulário conectados a uma entidade e vê funcionando em preview.
- Código gerado passa `npm run build` sem erros.
- Repositório exportado roda em Vercel com zero modificações.

---

### Épico 3 — Feature-Piloto: Gerenciador de Agents BMad

**Objetivo:** Provar fase 1. Diogo, usando apenas Épico 1 + Épico 2 (+ opcionalmente Épico 4 se já existir), constrói uma tela funcional de gerenciar agents BMad dentro do próprio Jarvis Hub.

**Nota:** este épico é de **uso**, não de construção do builder. Ele existe no PRD como **gate de validação**. Se falhar, o builder volta pra prancheta antes de seguir pro Épico 4.

**Stories esperadas:**
- 3.1 — Definir escopo exato da tela: fonte de dados dos agents (arquivos `.md` em `bmad/agents/` ou tabela SQLite — Winston decide se o builder acessa filesystem via adaptador ou se há sync para Postgres).
- 3.2 — Construir a tela usando o builder: listar, editar prompt, criar, deletar.
- 3.3 — Integrar a tela construída ao Jarvis Hub principal (rota acessível do menu).
- 3.4 — Medir tempo de construção vs. estimativa de código manual.

**Critérios de aceitação do épico:**
- Tela funcional, sem bugs críticos, em uso no Jarvis Hub.
- Nenhum arquivo `.tsx`, `.ts`, `.sql` ou `.prisma` editado manualmente pelo Diogo — tudo gerado via builder ou (se Épico 4 já existir) via agente.
- Tempo total de construção documentado e comparado a estimativa manual.

---

### Épico 4 — Agente de Código com Contexto de Repo

**Objetivo:** Adicionar camada de IA que edita múltiplos arquivos por instrução natural, com diff-review.

**Stories esperadas (espinha):**
- 4.1 — Indexador de projeto: estrutura de arquivos + conteúdo relevante como contexto para Claude.
- 4.2 — Endpoint de chat com tool use (`read_file`, `write_file`, `list_dir`, `run_command`).
- 4.3 — UI de chat lateral no builder com histórico por projeto.
- 4.4 — Renderizador de diff multi-arquivo com aceitar/rejeitar por arquivo.
- 4.5 — Sincronia builder ↔ agente: se agente edita componente representável, builder atualiza o JSON schema; se não, marca como "custom code".
- 4.6 — Rate limit e telemetria básica de uso de tokens.

**Critérios de aceitação do épico:**
- Instrução "adicione um botão de deletar em cada linha da lista de agents, com confirmação" resulta em diff correto aplicado em ≤ 3 arquivos relevantes.
- Rejeitar o diff não deixa estado sujo.
- Builder e agente não brigam: edições de um são visíveis no outro.

---

### Épico 5 — Workflows Visuais

**Objetivo:** Editor de fluxos que compila em route handlers/server actions.

**Stories esperadas (espinha):**
- 5.1 — Representação de workflow (nós, arestas, triggers, passos).
- 5.2 — Palette de passos nativos (HTTP, DB query, email, delay, condicional, loop).
- 5.3 — Gerador: workflow JSON → `app/api/*/route.ts` ou server action.
- 5.4 — Passo "código customizado" gerado via agente (depende do Épico 4).
- 5.5 — Testador de workflow com inputs mockados.

**Critérios de aceitação do épico:**
- Workflow "ao criar agent, enviar webhook para URL X" funciona em preview.
- Código gerado do workflow passa `npm run build`.

---

### Épico 6 — Editor Completo

**Objetivo:** Editor estilo Cursor pra quem quiser cair no código.

**Stories esperadas (espinha):**
- 6.1 — Integração de Monaco Editor (ou CodeMirror) no builder.
- 6.2 — Syntax highlight + autocomplete via LSP do TypeScript.
- 6.3 — Chat lateral com contexto do arquivo aberto (reusa Épico 4).
- 6.4 — Marcação de arquivos "custom" (fora do alcance do builder visual).
- 6.5 — Git panel mínimo: status + commit + push.

**Critérios de aceitação do épico:**
- Usuário edita um arquivo manualmente, builder reconhece o arquivo como custom, não sobrescreve.
- Autocomplete e ir-para-definição funcionam dentro do projeto.

---

### Épico 7 — Open Source Readiness & Comunidade

**Objetivo:** Tornar o core público e iniciar a comunidade.

**Stories esperadas (espinha):**
- 7.1 — Extrair core do builder + runtime para repositório GitHub público separado do Jarvis Hub privado do Diogo.
- 7.2 — README, LICENSE (MIT ou Apache 2.0), CONTRIBUTING.md, CODE_OF_CONDUCT.md.
- 7.3 — CI mínimo (lint + build + testes essenciais) no GitHub Actions.
- 7.4 — Canal de comunidade (Discord ou GitHub Discussions — decisão simples).
- 7.5 — Documentação "quickstart": instalar e criar primeiro projeto em ≤ 10 minutos.
- 7.6 — Página pública do projeto (pode ser GitHub Pages simples na fase 1).

**Critérios de aceitação do épico:**
- Repo público clonável, instalação em ≤ 3 comandos, primeiro projeto criado em ≤ 10 min por usuário novo.
- Licença clara, contribuições aceitáveis.

---

## 7. Fora de Escopo deste PRD

- Monetização, planos, cobrança, gateway de pagamento (fase 2).
- Multi-tenant / cloud hosting do builder (fase 1 é local).
- Colaboração em tempo real multi-usuário.
- Integrações com serviços externos específicos (Stripe, Auth0, etc.) — virão por demanda, não na espinha.
- Modelos de IA alternativos a Claude (fase 1 é só Max).
- Análise de economia unitária pra fase 2 (vira PRD separado quando chegar lá).

---

## 8. Riscos & Mitigações (refinamento dos riscos do brief)

| Risco                                                            | Mitigação                                                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Escopo "quero tudo" → nada entregue bem                          | Ordem dura de épicos; Épico 3 (piloto) é gate — não seguir pra Épico 4 se piloto falhar.                              |
| Código gerado ilegível / frágil                                  | NFR3 e NFR4 como requisitos duros; revisão do Winston no schema → código.                                             |
| Builder e agente divergirem (código manual quebra representação) | FR14 + Story 4.5 tratam sincronia explicitamente; arquivos "custom" são de primeira classe.                           |
| Competição (Cursor, v0, Bolt, Lovable) neutraliza diferencial    | Foco em **ex-Bubble + código real portável + open-source + comunidade** — nenhum concorrente cobre os 4 juntos hoje.  |
| Custo de Claude por usuário inviável pra fase 2                  | Fora deste PRD; sinalizado como bloqueio pra iniciar fase 2 (PRD novo quando chegar lá).                              |

---

## 9. Próximos Passos

1. **Winston (Arquiteto)** lê este PRD e escreve `docs/architecture.md` cobrindo:
   - Como o Visual Builder coexiste com o `server.js` atual do Jarvis Hub.
   - Escolha final: Prisma vs. Drizzle.
   - Formato exato da representação intermediária (JSON schema de páginas + componentes + dados).
   - Pipeline de geração de código (schema → arquivos Next.js idiomáticos).
   - Estratégia de sincronia builder ↔ agente (Épico 4 / FR14).
   - Separação de repositórios (privado do Diogo vs. público open-source — Épico 7).
2. **Bob (Scrum Master)** quebra cada épico em stories completas em `docs/stories/`, uma por arquivo, usando PRD + arquitetura.
3. Dev começa pelo Épico 1.
