# Architecture — Lista de Mercado

**Autor:** Winston (Architect)
**Data:** 2026-04-26
**Status:** v1 — documenta o desenho atual já implementado em `src/`
**Fases anteriores:** brief.md → mock.html → prd.md

---

## 1. Introdução

Documento de arquitetura da v1 do app **Lista de Mercado**. O escopo foi fechado pelo PRD em 8 FRs / 6 NFRs e 7 stories, todas implementadas. O objetivo aqui é **documentar retroativamente** o desenho atual, validar que ele é proporcional ao problema, e listar pontos de atenção pra v2.

A pergunta deixada pelo PM no PRD §8 — *"a divisão em 4 módulos é a certa, ou há sobre-engenharia?"* — é respondida em §10 (ADRs).

---

## 2. Arquitetura de Alto Nível

### Resumo Técnico
SPA client-side, single-page, sem framework, sem build step, sem backend. Módulos ES nativos servidos por qualquer servidor estático. Estado mantido em memória; persistência em `localStorage` na chave `listademercado.v1`. Renderização imperativa com `replaceChildren` em cada mutação (sem virtual DOM, sem reatividade).

### Diagrama de Componentes (lógico)

```
                    ┌──────────────┐
                    │  index.html  │  (DOM estrutural + entry)
                    └──────┬───────┘
                           │ <script type="module">
                           ▼
                    ┌──────────────┐
       ┌────────────┤   main.js    ├────────────┐
       │            │ (bootstrap)  │            │
       │            └──────┬───────┘            │
       │                   │                    │
       │ events            │ ações              │ refresh()
       │                   ▼                    │
       │            ┌──────────────┐            │
       │            │   store.js   │            │
       │            │ (estado +    │            │
       │            │  mutações)   │            │
       │            └──────┬───────┘            │
       │                   │ persist()          │
       │                   ▼                    │
       │            ┌──────────────┐            │
       │            │  storage.js  │            │
       │            │ (localStorage│            │
       │            │  wrapper)    │            │
       │            └──────────────┘            │
       │                                        ▼
       │                                 ┌──────────────┐
       └────────────────────────────────▶│  render.js   │
                                         │ (DOM output) │
                                         └──────────────┘
```

### Padrão Arquitetural
- **Unidirectional data flow** (event → ação no store → persist → re-render).
- **Separação por responsabilidade**, não por feature: cada módulo tem um único motivo pra mudar.
- **Render-everything-on-change**: simplicidade > diff fino. Lista é pequena (dezenas de itens), custo é desprezível.

---

## 3. Tech Stack

| Categoria | Escolha | Versão | Motivo |
|---|---|---|---|
| Markup | HTML5 | — | Mínimo viável; semântico (`<main>`, `<header>`, `<form>`, `<ul>`). |
| Estilo | CSS3 com custom properties | — | Tokens em `:root`, sem pré-processador. Mobile-first com 1 media query (≥600px). |
| Lógica | JavaScript (ESM nativo) | ES2022+ | `crypto.randomUUID`, optional chaining, etc. Sem transpilação. |
| Persistência | `localStorage` | — | Síncrono, ~5MB, suficiente pro caso de uso. Sem IndexedDB (overkill). |
| Runtime | Navegador moderno | últimos 2 anos | Sem polyfills. ESM exige HTTP (não `file://`). |
| Build | nenhum | — | Decisão consciente (NFR1). |
| Servidor dev | `python3 -m http.server` | — | Qualquer estático serve. |
| Testes | manual (v1) | — | Automação fica pra v2 (ver §13). |

**Dependências externas em runtime:** zero. App roda offline após primeiro load (NFR5).

---

## 4. Estrutura de Pastas

```
projetos/listademercado/
├── index.html              # entry + DOM estático
├── mock.html               # design estático (referência visual)
├── styles/
│   └── main.css            # tokens + layout
├── src/
│   ├── main.js             # bootstrap + event handlers
│   ├── store.js            # estado + ações (CRUD)
│   ├── storage.js          # wrapper localStorage
│   └── render.js           # DOM output
├── brief.md                # fase Analyst
├── prd.md                  # fase PM
├── architecture.md         # este documento
└── README.md               # instruções de execução
```

**Convenção:** módulos JS em `src/`, estilos em `styles/`, docs BMAD na raiz do projeto.

---

## 5. Módulos / Componentes

### 5.1 `src/main.js` — Bootstrap & Controller
**Responsabilidade:** ligar DOM a ações do store; orquestrar o ciclo `event → ação → refresh`.

- Captura referências do DOM uma vez no carregamento.
- Define `refresh()` = `renderList(getState())`.
- Registra 4 listeners: `submit` no form, `change` na lista (delegado para checkbox), `click` na lista (delegado para botão remove), `click` no botão limpar.
- Faz `refresh()` inicial + foco no input.

**Não conhece:** estrutura interna do estado, formato de persistência, layout do DOM da lista.

### 5.2 `src/store.js` — Estado & Ações
**Responsabilidade:** única fonte de verdade do estado em memória + API de mutação.

```js
// API pública
getState()                    → { items: Item[] }
addItem(name: string)         → boolean   // false se vazio
toggleBought(id: string)      → void
removeItem(id: string)        → void
clearAll()                    → void
```

- Estado é objeto mutável (sim, mutação direta — ver ADR §10).
- Toda mutação chama `persist()` antes de retornar.
- `addItem` faz trim e ignora vazio (FR1 + AC3 da Story 1.1).
- `addItem` insere no **topo** (`unshift`) — itens novos aparecem primeiro antes da reordenação por status.

**Não conhece:** DOM, eventos, formato de armazenamento.

### 5.3 `src/storage.js` — Persistência
**Responsabilidade:** wrapper sobre `localStorage` com fallback seguro.

```js
load(): { items: Item[] }     // sempre retorna shape válido
save(state): void             // engole erro silenciosamente
```

- Chave fixa: `listademercado.v1` (versionada → permite migração futura).
- `load()` valida shape (`Array.isArray(parsed.items)`) e cai para `{ items: [] }` em qualquer falha (parse, ausência, shape inválido).
- `save()` ignora `QuotaExceededError`/`SecurityError` — app continua em memória (NFR5 best-effort).

**Não conhece:** estrutura semântica de Item, regras de negócio.

### 5.4 `src/render.js` — Apresentação
**Responsabilidade:** materializar `state` em DOM.

```js
renderList(state): void
```

- Lê referências de DOM uma vez no carregamento do módulo.
- Calcula `total` e `pendentes` localmente.
- **Estado vazio:** esconde lista + clear, mostra `empty-state`.
- **Com itens:** mostra lista ordenada (pendentes recentes → comprados recentes), atualiza contador, mostra clear.
- Constrói nós com `document.createElement` (sem `innerHTML` → seguro contra XSS por construção).
- Usa `replaceChildren` com `DocumentFragment` para minimizar reflow.
- Adiciona `data-action` e `data-id` para event delegation no `main.js`.

**Não conhece:** como o estado mudou, persistência, validação.

---

## 6. Modelo de Dados

### Tipo `Item`
```ts
{
  id: string         // UUID v4 (crypto.randomUUID)
  name: string       // texto livre, trim aplicado, max 80 chars (validado no input HTML)
  bought: boolean    // estado de compra
  createdAt: number  // Date.now() — usado para ordenação
}
```

### Tipo `State`
```ts
{
  items: Item[]      // array mutável; sem outros campos no nível raiz (deixa espaço pra futuro)
}
```

### Formato persistido (`localStorage["listademercado.v1"]`)
JSON serializado de `State`. Versão na chave permite migração não-destrutiva (criar `v2` sem apagar `v1`).

---

## 7. Fluxo de Dados

### Adicionar item (caminho feliz)
```
[input "leite" + Enter]
  → form.submit
  → main.js: e.preventDefault() + addItem("leite")
  → store.js: trim → push em items → persist()
  → storage.js: localStorage.setItem(KEY, JSON.stringify(state))
  → main.js: input.value = "" + refresh()
  → render.js: renderList(state) → atualiza DOM
```

### Carregamento inicial
```
DOMContentLoaded → main.js importa
  → store.js importa storage.js → load() → state = { items: [...] }
  → main.js anexa listeners
  → main.js chama refresh() → render.js renderiza
  → main.js foca o input
```

---

## 8. Gerenciamento de Estado

- **Single source of truth** = objeto `state` em `store.js` (escopo de módulo).
- **Mutação direta**, não imutabilidade. Justificativa: app pequeno, sem reatividade, sem bibliotecas. Imutabilidade seria cerimônia sem benefício.
- **Sem subscribers/observers.** O `main.js` chama `refresh()` explicitamente após cada ação. Trade-off aceito: acoplamento explícito > complexidade de pub/sub.
- **Re-render completo** a cada `refresh()`. Aceitável até dezenas/baixas centenas de itens. Acima disso, considerar diff incremental (não previsto pra v1).

---

## 9. Persistência

### Estratégia
- **Write-through:** toda mutação grava imediatamente. Sem debounce. Sem batching.
- **Read-once:** `load()` chamado uma vez no boot do módulo `store.js`. Sem polling, sem `storage` events (multi-aba não é requisito).

### Chave versionada
`listademercado.v1` permite que uma v2 mude o shape sem precisar migrar dados antigos no mesmo deploy. Se v2 quiser ler v1, faz na inicialização.

### Tratamento de erro
- Leitura corrompida → `{ items: [] }` (silencioso).
- Escrita falha (cota cheia, modo privado restrito) → silenciosa, app continua em memória, próxima ação tenta de novo.
- Decisão de não notificar o usuário: caso de uso é trivial, chance de erro real é baixa, mensagem assustaria sem agregar valor.

---

## 10. Decisões Arquiteturais (ADRs)

### ADR-001 — Sem framework
**Decisão:** Vanilla JS com módulos ES nativos.
**Por quê:** App tem ~3 telas de estado, ~5 ações, ~50 linhas de render. React/Vue/Svelte adicionariam build step, dependências e mental overhead desproporcionais. NFR1 explicita.
**Trade-off:** Não temos reatividade nem componentização "de graça". Aceitável dado o tamanho.

### ADR-002 — `localStorage` em vez de IndexedDB
**Decisão:** `localStorage` síncrono.
**Por quê:** Volume de dados é pequeno (texto + bool por item), API síncrona simplifica o flow `mutar → persistir`. IndexedDB pediria async em todas as ações.
**Trade-off:** Limite de ~5MB e bloqueio de thread. Nenhum dos dois é problema na escala atual.

### ADR-003 — Divisão em 4 módulos (`main`, `store`, `storage`, `render`)
**Decisão:** Manter os 4 módulos.
**Por quê (resposta direta à pergunta do PRD §8):** Não é sobre-engenharia. Cada módulo tem um motivo distinto pra mudar:
- `storage` muda se trocarmos backend de persistência (IndexedDB, sync server).
- `store` muda se mudarem regras de negócio (deduplicação, categorias).
- `render` muda se redesenharmos UI.
- `main` muda se adicionarmos novas ações/atalhos.

Juntar `store` + `storage` seria razoável (~50 linhas combinadas), mas a separação atual deixa o caminho aberto pra trocar `localStorage` por outra coisa sem tocar em lógica de negócio. **Custo da separação ≈ zero**, então o critério "remover só se removendo simplifica" não dispara.

Dividir mais (ex.: extrair `validators.js` ou `dom.js`) **seria** sobre-engenharia agora.

### ADR-004 — Renderização full-replace
**Decisão:** `replaceChildren` com fragment a cada mutação.
**Por quê:** Lista pequena, código trivial, zero estado intermediário. Diff fino seria ganho marginal com complexidade real.
**Trade-off:** Perde-se foco/scroll de elementos da lista durante re-render. Não é problema porque a lista não tem inputs editáveis (só checkbox + botão sem foco persistente esperado).

### ADR-005 — Mutação direta de estado
**Decisão:** `state.items.unshift(...)`, `state.items = state.items.filter(...)`.
**Por quê:** Sem framework, sem detecção de mudança via referência. Imutabilidade não traria benefício, só verbosidade.
**Trade-off:** Se algum dia adicionarmos undo/history, precisaremos refatorar. Aceito.

### ADR-006 — Event delegation
**Decisão:** Listeners no `<ul>` pai, não em cada item.
**Por quê:** Lista é redesenhada inteira a cada mutação. Anexar listeners a cada `<li>` significaria reanexar a cada render. Delegação resolve uma vez.

### ADR-007 — Sem confirmação ao remover item individual; confirma ao limpar tudo
**Decisão:** `confirm()` só no `clearAll`.
**Por quê:** Remover 1 item é trivialmente reversível (re-digita). Apagar tudo não é. Confirmação onde dói, atrito mínimo onde não dói.

---

## 11. Performance

| Métrica | Alvo (NFR3) | Realidade |
|---|---|---|
| Adicionar item | <100ms | <5ms (operação síncrona local + localStorage write) |
| Render N=100 | imperceptível | ~5–10ms (DOM puro, sem layout thrash) |
| Boot inicial | <500ms | dominado por download dos 4 módulos (~5KB total não-minificado) |

**Pontos de atenção pra crescer:**
- Acima de ~500 itens, o re-render full pode começar a ser visível em mobile lento. Mitigação: virtualizar ou diffar.
- `localStorage` síncrono pode bloquear quando o JSON cresce. Mitigação: trocar por IndexedDB (ADR-002 reaberto).

---

## 12. Segurança

| Vetor | Mitigação atual |
|---|---|
| XSS via texto do item | `textContent` em `render.js`, nunca `innerHTML`. Seguro por construção. |
| CSRF | N/A (sem backend). |
| localStorage roubado por XSS | N/A (não há dado sensível — só texto que o próprio usuário digitou). |
| Tracking/cookies | Nenhum (NFR6). |
| Dependências comprometidas | Zero dependências em runtime. |

**Modelo de ameaça:** o app é local, sem multiusuário, sem dado sensível. Vetor real é só XSS auto-infligido se algum dia introduzirmos `innerHTML` — checar em code review.

---

## 13. Estratégia de Testes

### v1 — manual
- Roteiros documentados nos ACs do PRD §6. Testar cada AC manualmente após mudanças.
- Casos de borda obrigatórios:
  - Texto vazio / só espaços → não adiciona.
  - Item duplicado → permite (FR8).
  - localStorage desabilitado (modo privado strict) → app funciona em memória, não quebra.
  - 50+ itens → ordenação e contador corretos.

### v2 — automação proposta
- **Unit:** `store.js` é função-pura-friendly (com mock de `storage`). Vitest sem JSDOM.
- **Integração:** `render.js` + DOM real via JSDOM ou Playwright Component Testing.
- **E2E:** 1 happy path em Playwright (adicionar → marcar → reload → verificar).

Não introduzir test runner antes da v2 — adicionaria build/deps que NFR1 proíbe pra v1.

---

## 14. Padrões de Código

- **Módulos ES nativos**, sem default export (named exports só, mais fácil de refatorar).
- **Sem comentários** em código óbvio. Comentar só o "por quê" não óbvio (ex.: o `catch` silencioso em `storage.js` que diz `// localStorage cheio ou desabilitado — segue em memoria`).
- **Acessibilidade:** `aria-label` em todo botão sem texto visível (`×`), `<label class="visually-hidden">` em inputs sem label visível.
- **Tokens CSS** em `:root` — não usar valores literais de cor/spacing dentro das regras.
- **Tap targets** mínimo 44px (`--tap`) — aplicado em form, botões, checkbox.

---

## 15. Riscos & Tech Debt

| Item | Severidade | Quando vira problema |
|---|---|---|
| Sem testes automatizados | Baixa hoje | Quando v2 começar a iterar e regressões aparecerem. |
| `localStorage` síncrono | Baixa | Listas com centenas de itens, mobile lento. |
| Sem multi-aba sync | Baixa | Se usuário abrir 2 abas e editar nas duas. Hoje aceitamos a última a salvar ganha. |
| Sem migração de schema | Média | Quando v2 mudar shape do `Item`. Mitigação parcial: chave versionada (§9). |
| Mock e index não compartilham CSS de variantes | Baixa (cosmético) | Se `mock.html` divergir do real, design pode dessincar. |

**Sem tech debt explícito no código.** A arquitetura é proporcional ao escopo.

---

## 16. Próximos Passos

### Para Dev (já entregue)
- Todas as 7 stories da v1 estão implementadas. Nada pendente.

### Para QA (próximo agente)
- Executar manualmente os ACs do PRD §6 contra a build atual.
- Validar acessibilidade básica (navegação por teclado, leitor de tela em pelo menos 1 fluxo).
- Validar comportamento em modo privado / `localStorage` bloqueado.

### Para v2 (quando o PM reabrir backlog)
- Reabrir ADR-002 se PWA/offline real for entrar.
- Considerar `subscribers` no store quando houver >2 consumidores de estado (hoje só `render`).
- Introduzir test runner antes da primeira nova feature da v2.

---

**Fim — handoff para QA.**
