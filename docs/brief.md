# Project Brief — Jarvis Hub: Modo de Código

**Autor:** Diogo (via Mary, analista de negócios)
**Data:** 2026-04-24
**Status:** Rascunho para validação do John (PM)

---

## 1. Visão

Evoluir o **Modo de Código** do Jarvis Hub de um chat simples com acesso à pasta local para uma **IDE no-code/low-code**, combinando a experiência visual do **Bubble.io** com a potência de agente de código do **Cursor / Claude Code**, usando **Claude (plano Max)** como motor de IA.

O diferencial proposto é entregar ao usuário **código real gerado e editável** — não um runtime proprietário como o Bubble — para que o produto construído possa sair da plataforma sem lock-in.

---

## 2. Estado Atual (hoje)

O Jarvis Hub já existe e roda localmente:

- Backend Node.js (`server.js` monolítico, ~39KB)
- SQLite (`better-sqlite3`) em `data/jarvis.db`
- Frontend vanilla em `public/index.html` único
- Workers e providers em `lib/workers/`
- Puppeteer-core disponível

**Modo de Código atual:**
- Acessa a pasta local `/home/diogo/jarvis-hub`
- Chat com contexto

Nada além disso. Essa é a linha de base — tudo no brief é novo.

---

## 3. Usuário

**Primário (fase 1 — validação):** o próprio Diogo, em uso pessoal, para validar que o produto funciona antes de vender.

**Primário (fase 2 — comercial):** **no-coders que hoje pagam ferramentas tipo Bubble e querem sair**. Três dores explícitas:

1. **Preço** — cansaram do custo mensal de ferramentas como Bubble, Webflow, Softr, etc.
2. **Controle** — querem **código real**, editável, hospedável em qualquer lugar, sem lock-in de plataforma.
3. **Comunidade** — querem uma comunidade muito mais ativa do que a das ferramentas no-code atuais (fóruns mornos, suporte oficial lento, poucos recursos gratuitos de aprendizado).

Perfil adicional:
- Já têm fluência em pensar "visualmente" (componentes, workflows, banco de dados)
- Não querem (ou não conseguem) aprender a codar do zero
- Já constroem produtos reais (não são hobby) — provavelmente indie hackers, solopreneurs, agências pequenas

**Não-usuário (por enquanto):** desenvolvedores experientes — já têm Cursor/Claude Code; não é o público-alvo da venda.

---

## 4. Problema

Hoje o no-coder tem dois mundos ruins:

1. **Ficar no Bubble/Webflow/Softr/etc.** → sem código real, locked-in, **caro** (assinaturas que escalam com uso), comunidade morna presa a fóruns oficiais.
2. **Migrar pra Cursor/Claude Code** → ferramenta feita para dev, curva íngreme, sem visual builder, pressupõe conhecimento de repo/git/deploy.

**Não existe hoje** uma ferramenta que entregue a **UX do Bubble** (arrastar, conectar, publicar) com **código real**, **preço justo** e uma **comunidade ativa** editando esse código por baixo com apoio de agente de IA de ponta.

---

## 5. Solução Proposta (alto nível)

Transformar o Modo de Código do Jarvis Hub em uma IDE visual-first com 4 camadas, entregues **nesta ordem**:

1. **Visual Builder (camada Bubble)** — arrastar componentes, editar props visualmente, ver o código real sendo gerado em tempo real.
2. **Agente de Código + Chat com contexto de repo** — "faça X neste componente", o agente edita o arquivo certo; usuário vê o diff e aplica.
3. **Workflows Visuais** — fluxos tipo if/then/loop que geram código (backend handlers, automações).
4. **Editor completo estilo Cursor** — pra quem quiser entrar no código manualmente, com autocomplete inline e chat lateral.

Motor de IA: **Claude via plano Max** (já disponível para o Diogo).

---

## 6. Métrica de Sucesso

**Norte:** "ferramenta melhor que Claude Code **para o público no-coder ex-Bubble**".

Tradução operacional (a ser refinada pelo John no PRD):

- **Fase 1 (uso próprio):** Diogo consegue construir uma feature nova do próprio Jarvis Hub usando o novo Modo de Código, sem escrever código manualmente, em tempo menor do que escreveria à mão.
- **Fase 2 (venda):** N primeiros usuários pagos conseguem migrar um app Bubble simples para código real rodando fora da plataforma.

---

## 7. Escopo fora deste brief

- Monetização / pricing
- Onboarding público / marketing
- Multi-tenant / cloud hosting — fase 1 é local
- Colaboração multi-usuário em tempo real
- Integrações com serviços externos específicos (Stripe, Auth0 etc.) — virão por demanda

---

## 8. Restrições e Premissas

- **Stack atual deve ser preservada** onde fizer sentido (Node.js, SQLite, workers, Puppeteer). Refactor é aceitável, reescrita completa não.
- **Claude Max** é o único motor — não há orçamento para rodar outros modelos em paralelo na fase 1.
- **Deploy local primeiro** — roda na máquina do Diogo antes de virar SaaS.
- **Código gerado deve ser legível e portável** — stack-alvo do código gerado a definir com Winston (provavelmente Next.js ou similar, mas é decisão de arquitetura).

---

## 9. Riscos Conhecidos

- **"Quero tudo" é escopo enorme** — risco de não entregar nada bem. Mitigação: sequência de 4 camadas, cada uma entregável em isolado.
- **Competição pesada** — Cursor, v0.dev, Bolt.new, Lovable já atacam esse espaço. O diferencial "ex-Bubble + código real + preço justo + comunidade ativa + Claude Max" precisa ser afiado no PRD.
- **Público no-coder é exigente em UX** — qualquer fricção mata adoção. O visual builder tem que ser de verdade bom, não placeholder.
- **Comunidade não se constrói sozinha** — prometer "comunidade ativa" exige estratégia deliberada (Discord, open-source parcial, programa de criadores, documentação pública). Precisa entrar no PRD como trabalho explícito, não efeito colateral.
- **Preço como diferencial é frágil** — se o custo do Claude Max por usuário inviabilizar margem, a promessa "mais barato que Bubble" cai. John precisa endereçar a economia unitária no PRD.

---

## 10. Decisões Fechadas com o John

- **Stack-alvo do código gerado:** **Next.js + Postgres** (padrão de mercado, hospedagem barata, comunidade gigante).
- **Feature-piloto da Fase 1 (validação):** **Tela de gerenciamento dos agents BMad** — listar agents, editar seus prompts, salvar. Será construída pelo Diogo usando o novo Modo de Código, sem escrever código manualmente.
- **Licenciamento:** **Core open-source no GitHub** — repositório público pelo menos para o runtime do código gerado e o builder. Estratégia de comunidade se apoia nisso.

---

## 11. Próximos Passos

1. **John (PM):** transformar este brief em `docs/prd.md` — épicos, requisitos funcionais/não-funcionais, critérios de aceitação da camada 1 (Visual Builder) e da feature-piloto (gerenciador de agents BMad).
2. **Winston (Arquiteto):** após PRD, desenhar `docs/architecture.md` — como Next.js+Postgres convive com o Node+SQLite atual do Jarvis Hub, como o visual builder emite código Next.js, como o agente integra com o `server.js` atual.
3. **Bob (Scrum Master):** quebrar em stories em `docs/stories/`.
