# PRD — Lista de Mercado

**Autor:** John (PM)
**Data:** 2026-04-26
**Status:** Draft v1
**Fase anterior:** brief.md

---

## 1. Goals and Background Context

### Goals
- Permitir que o usuário monte uma lista de compras de forma rápida, sem fricção (sem login, sem cadastro).
- Marcar itens como comprados durante a ida ao mercado, com feedback visual claro.
- Persistir a lista entre sessões no mesmo dispositivo (sobrevive a reload e fechar/abrir do navegador).
- Funcionar bem em mobile (uso primário é com o celular na mão dentro do mercado).

### Background Context
Apps de lista de compras existem aos montes, mas a maioria pede cadastro, sincroniza coisas que o usuário não pediu, ou enche a tela de features (categorias, preços, histórico) que atrapalham o caso de uso real: anotar rápido, riscar no mercado, esquecer.

A proposta aqui é o oposto: uma página única, client-side, sem backend, sem conta, com persistência local. O escopo é deliberadamente pequeno — se a interação demorar mais de 2 segundos para adicionar um item, falhamos.

---

## 2. Requirements

### Functional Requirements (FR)
- **FR1** — Usuário adiciona um item digitando texto livre e confirmando (Enter ou botão).
- **FR2** — Usuário marca/desmarca um item como comprado via checkbox.
- **FR3** — Usuário remove um item individualmente.
- **FR4** — Usuário limpa toda a lista com confirmação prévia.
- **FR5** — Lista é persistida em `localStorage` e restaurada ao abrir o app.
- **FR6** — Tela exibe contador `X de Y itens` (comprados / total).
- **FR7** — Lista vazia exibe mensagem orientando o usuário a adicionar o primeiro item.
- **FR8** — Item duplicado é permitido (não há deduplicação — usuário pode querer "2 leites").

### Non-Functional Requirements (NFR)
- **NFR1** — Sem backend, sem build step. Vanilla HTML/CSS/JS, módulos ES nativos.
- **NFR2** — Mobile-first. Layout funcional em telas a partir de 320px.
- **NFR3** — Adicionar item deve responder em <100ms (operação local).
- **NFR4** — Acessibilidade básica: labels nos inputs, `aria-label` nos botões de ação.
- **NFR5** — Funciona offline depois do primeiro carregamento (sem dependências externas em runtime).
- **NFR6** — Sem tracking, sem analytics, sem cookies.

---

## 3. User Interface Design Goals

### Overall UX Vision
Tela única, fluxo único: campo no topo → lista no meio → ação destrutiva no rodapé. Nada de menus, abas, ou navegação. O mock.html já reflete a direção visual aprovada.

### Key Interaction Paradigms
- Adicionar: digitar + Enter (primary action sempre acessível no topo).
- Marcar comprado: tap no checkbox; item ganha visual "riscado" (estado `bought`).
- Remover: botão `×` à direita de cada item, sem confirmação (item único é facilmente refeito).
- Limpar tudo: botão no rodapé, com `confirm()` (ação destrutiva em massa).

### Core Screens
- Tela única (`index.html`): header + form + lista + botão limpar.
- Estado vazio: mesma tela, lista substituída por mensagem.

### Accessibility
WCAG AA básico — contraste, labels, navegação por teclado.

### Branding
Visual minimalista, sem identidade forte. Tipografia padrão do sistema, paleta neutra, foco em legibilidade.

### Target Devices
Mobile-first, mas funcional em desktop (mesmo layout, sem versão separada).

---

## 4. Technical Assumptions

- **Repository:** monorepo (subpasta dentro de `projetos/` no Jarvis Hub).
- **Architecture:** client-side puro, single-page, sem framework.
- **Stack:** HTML5 + CSS3 (custom properties) + JS módulos ES.
- **Persistência:** `localStorage` com chave `listademercado.v1`.
- **Servir:** qualquer servidor estático (dev: `python3 -m http.server`).
- **Testing:** manual nesta versão. Testes automatizados ficam para v2.

---

## 5. Epic List

- **Epic 1 — CRUD da Lista**: adicionar, marcar, remover, limpar.
- **Epic 2 — Persistência**: salvar e restaurar do `localStorage`.
- **Epic 3 — Feedback Visual**: contador e estado vazio.

---

## 6. Epic Details

### Epic 1 — CRUD da Lista
**Objetivo:** Operações básicas sobre a lista de itens.

- **Story 1.1 — Adicionar item**
  - AC1: Campo de texto + botão "Adicionar" no topo.
  - AC2: Submeter via Enter ou clique no botão.
  - AC3: Texto vazio (ou só whitespace) não adiciona.
  - AC4: Limite de 80 caracteres no input.
  - AC5: Após adicionar, campo é limpo e mantém foco.

- **Story 1.2 — Marcar como comprado**
  - AC1: Checkbox à esquerda de cada item.
  - AC2: Toggle aplica/remove classe `bought` (visual riscado).
  - AC3: Estado refletido no contador imediatamente.

- **Story 1.3 — Remover item**
  - AC1: Botão `×` à direita de cada item.
  - AC2: Sem confirmação (ação reversível pelo usuário re-adicionando).
  - AC3: Item desaparece da tela; contador atualiza.

- **Story 1.4 — Limpar lista**
  - AC1: Botão "Limpar lista" no rodapé, sempre visível quando há itens.
  - AC2: Confirmação via `confirm()` antes de apagar.
  - AC3: Após confirmação, lista zera e estado vazio aparece.

### Epic 2 — Persistência
**Objetivo:** Lista sobrevive entre sessões.

- **Story 2.1 — Persistir em localStorage**
  - AC1: Toda mutação (add/toggle/remove/clear) salva no `localStorage`.
  - AC2: Ao carregar a página, lista é restaurada da chave `listademercado.v1`.
  - AC3: Falha de leitura/parse não quebra o app (cai para lista vazia).

### Epic 3 — Feedback Visual
**Objetivo:** Usuário entende o estado da lista de relance.

- **Story 3.1 — Estado vazio**
  - AC1: Quando lista tem 0 itens, exibe mensagem "Sua lista está vazia" (ou similar).
  - AC2: Botão "Limpar lista" oculto nesse estado.

- **Story 3.2 — Contador**
  - AC1: Header exibe `X de Y itens` (X = comprados, Y = total).
  - AC2: Atualiza em tempo real após qualquer mutação.

---

## 7. Checklist Results

| Item | Status |
|---|---|
| Goals claros e mensuráveis | ✅ |
| FRs cobrem todas as stories | ✅ |
| NFRs explicitam restrições técnicas | ✅ |
| UI design alinhada com mock.html | ✅ |
| Stories têm ACs testáveis | ✅ |
| Stack/persistência definidas | ✅ |
| Escopo v1 fechado (sem feature creep) | ✅ |

**Observação:** as 7 stories listadas já constam como implementadas no README do projeto. O PRD aqui formaliza retroativamente o escopo entregue, fechando a fase de PM antes de seguir para Arquitetura/QA.

---

## 8. Next Steps

### Para o Architect
- Revisar `src/` (`main.js`, `store.js`, `storage.js`, `render.js`) e produzir `architecture.md` documentando o desenho atual (separação de responsabilidades, fluxo de dados, contrato do `store`).
- Avaliar se a divisão em 4 módulos é a certa para v1, ou se há sobre-engenharia.

### Para o SM (Scrum Master)
- Stories desta v1 já estão implementadas; não há trabalho de SM pendente.
- Quando v2 for definida (ver abaixo), gerar story files individuais a partir dos épicos.

### Backlog v2 (fora do escopo deste PRD)
- Editar texto de item existente.
- Reordenar itens (drag-and-drop).
- Exportar/compartilhar lista (texto, link).
- Categorias/agrupamento.
- PWA (instalável, ícone na home).
- Testes automatizados.
