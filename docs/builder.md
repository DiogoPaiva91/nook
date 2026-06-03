# Builder — Editor visual estilo Bubble

Editor low-code in-app pra construir páginas sem escrever JSX. Vive 100% no `public/index.html` (vanilla JS, sem dependências). Estado e lógica marcados por `// ── Builder ──` blocks.

## Quando ativar

- Em **Code mode**, com qualquer projeto selecionado em `~/dev/projetos/`
- Toggle: botão `🧱 Builder` no project bar **ou** atalho `Ctrl+B`
- Não funciona em `~/dev/jarvis` (o próprio Hub) — só em projetos do user

## Layout

```
┌─────────────┬─────────────────────┬───────────────┐
│   Esquerda  │       Canvas        │    Direita    │
│  (240px)    │     (iframe)        │   (300px)     │
├─────────────┤                     ├───────────────┤
│ Page picker │  Toolbar:           │ Tabs:         │
│ + ✎ rename  │  ↶↷ undo/redo      │ Props |       │
│ + 🗑 delete │  Edit/Preview       │ Workflows     │
│             │  Breakpoints        │               │
│ Components  │  ↻ reload  { }      │ Tipo (swap)   │
│ palette     │                     │ Texto         │
│ (drag)      │  ────────────       │ Layout        │
│             │                     │ Typography    │
│ Element     │  Tailwind Play CDN  │ Color         │
│ tree        │  + JSON renderer    │ Add child     │
│ + filtro    │  vanilla DOM        │ Wrap in...    │
│             │                     │               │
│ 💾 Save     │                     │               │
│ 📤 Export   │                     │               │
│ 📥 Runtime  │                     │               │
└─────────────┴─────────────────────┴───────────────┘
```

## Page format

Pages vivem em `<projeto>/jarvis-pages/<nome>.page.json`:

```json
{
  "name": "home",
  "root": {
    "id": "el_a3b9z2",
    "type": "Container",
    "props": { "className": "min-h-screen p-8" },
    "children": [
      {
        "id": "el_xyz123",
        "type": "Heading",
        "props": { "text": "Olá", "className": "text-2xl font-bold" },
        "children": []
      }
    ]
  }
}
```

Cada nó tem:
- `id` — único (gerado por `builderUid()`)
- `type` — um dos `BUILDER_TYPES` (ver tabela abaixo)
- `props` — `className`, `text`, `placeholder`, `src`, `href` conforme o tipo
- `children` — array de nós (só Container/Card/Section têm)
- `events` — opcional, mapa `{ onClick: [...actions] }` (ver Workflows)

## Tipos suportados

| Tipo | Tag HTML | Aceita filhos | Suporta texto | Outros props |
|---|---|---|---|---|
| `Container` | div | sim | — | — |
| `Card` | div | sim | — | — |
| `Section` | section | sim | — | — |
| `Heading` | h1 | — | sim | — |
| `H2` | h2 | — | sim | — |
| `H3` | h3 | — | sim | — |
| `Text` | p | — | sim | — |
| `Link` | a | — | sim | `href` |
| `Button` | button | — | sim | — |
| `Input` | input | — | — | `placeholder` |
| `Image` | img | — | — | `src` |
| `Divider` | hr | — | — | — |
| `Badge` | span | — | sim | — |
| `Avatar` | div | — | sim | — |

Cada tipo tem uma `base` className shadcn-like aplicada no canvas. No Export, pode ser sobrescrita por componentes shadcn reais (ver Export).

## Templates de página

Ao criar nova página (botão `+`), modal mostra galeria de 7 templates:

- **Blank** — Container vazio
- **Welcome** — Card com input + botão (default)
- **Hero** — Headline + subtitle + CTAs centrados
- **Login** — Form com email/senha
- **Two-column** — Sidebar + main
- **Pricing** — 3 cards lado a lado
- **Dashboard** — Topbar + 3 stat cards

Cada template é uma função em `BUILDER_PAGE_TEMPLATES[key].build(name)` que retorna um JSON. Adicionar novo: editar a constante.

## Drag-drop

3 fluxos:
1. **Palette → tree row**: insere como child/sibling baseado em Y do drop (top 25% = before, bottom 25% = after, meio = inside).
2. **Palette → canvas**: insere no elemento selecionado (se aceita filhos) ou no root.
3. **Tree row → tree row**: reordena (move). Bloqueado se for mover pra dentro de descendente próprio.

MIME types: `application/x-jbuilder-new` (palette → adicionar) e `application/x-jbuilder-move` (mover existente).

## Properties panel

**Aba Props:**

- **Tipo** — dropdown que troca o tipo do nó mantendo props (avisa antes se vai perder filhos)
- **Texto / Placeholder / URL / Src** — conforme suportado
- **Classes Tailwind** — textarea livre, full controle
- **Layout** (segmented controls): Display, Direção, Justify, Align, Gap, Padding, Largura, Borda
- **Typography** (segmented): Tamanho, Peso, Align, Italic
- **Color** (swatches): Texto + Fundo (23 cores da paleta shadcn)
- **Excluir / Duplicar / Wrap em Container/Card/Section**
- **Add child**: dropdown com todos os tipos

**Aba Workflows** (só pra tipos com eventos):

- Lista de eventos do tipo (Button: onClick; Input: onChange/Focus/Blur; etc.)
- Cada evento tem lista de actions sequenciais
- Actions: `alert(text)`, `log(text)`, `navigate(url)`, `setState(key, value)`, `fetch(url, method)`
- Reordenar: ↑↓; remover: ✕

## Edit / Preview mode

Toggle no canvas toolbar.

- **Edit**: click seleciona elemento (postMessage iframe → parent), hover mostra outline tracejado, eventos não disparam.
- **Preview**: click executa actions reais do `events`. Útil pra testar fluxos antes do export.

## Save / Auto-save

- `💾 Salvar` ou `Ctrl+S` salva via `/api/fs` write.
- Auto-save a cada 8s se dirty (silencioso).
- Header mostra "✓ salvo há Xs" / "● não salvo".
- Undo/redo: 50 níveis (`Ctrl+Z` / `Ctrl+Shift+Z`).

## Export to JSX (`📤 Export`)

Detecta framework via `package.json`:

| Framework | Output | Comportamento |
|---|---|---|
| Vite | `src/jarvis-pages/<name>.tsx` | + atualiza `src/jarvis-pages/index.ts` (re-exports) |
| Next.js | `src/app/<name>/page.tsx` | Vira rota direta. `home`/`index` → `/` |

Se `components.json` existe (template vite-shadcn), Export é **shadcn-aware**:
- Imports `Button`/`Card`/`Input` de `@/components/ui/*`
- Não duplica classes-base (componente shadcn já tem o styling)
- Imports agrupados no topo

Workflows viram handlers JSX inline:
```jsx
<Button onClick={() => { alert("Logando..."); }}>Entrar</Button>
```

## Install Runtime (`📥 Runtime`)

Alternativa ao Export: copia um componente que renderiza `.page.json` em runtime (Bubble-style live binding — edite no Builder, salve, app atualiza).

Escreve:
- `src/components/JBuilderPage.tsx` — renderer (~80 linhas TS)
- `src/jarvis-pages/<name>.page.json` (cópia de cada página)
- `src/jarvis-pages/index.ts` — re-exports JSON imports

Uso no app:
```tsx
import { JBuilderPage } from "@/components/JBuilderPage";
import { home } from "@/jarvis-pages";

export default function App() {
  return <JBuilderPage page={home} />;
}
```

Modal pós-install mostra snippet pronto pra copiar.

## Atalhos

| Tecla | Ação |
|---|---|
| `Ctrl+B` | Toggle Builder |
| `Ctrl+S` | Salvar página |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `Ctrl+D` | Duplicar elemento selecionado |
| `Delete` / `Backspace` | Excluir elemento |
| `Esc` | Deselecionar |

## API endpoints relevantes

Builder usa as APIs existentes — não tem rota dedicada:

- `POST /api/fs` (action=write/delete) — read/write `.page.json`
- `GET /api/files?path=...` — lista pages
- `GET /api/file-content?path=...` — lê page

## Limites conhecidos

- Canvas usa **Tailwind CDN** (`https://cdn.tailwindcss.com`) — first paint mostra warning no console; não usa as cores customizadas do shadcn (CSS variables) porque seria preciso copiar todo o tema. Workaround: use cores Tailwind diretas (slate/violet/sky/etc).
- Sem suporte a `hover:` / `focus:` modifiers visualmente — digite na textarea de classes.
- Sem responsive prefix (`md:flex` etc) na UI — digite na textarea.
- Workflows não têm flowchart visual — só lista vertical.
- Data tab (schema visual) ainda não implementado — `node.events.setState` existe mas não há UI pra inicializar state.
- Ao re-Export, sobrescreve manualmente edições no `.tsx`. Use Runtime se quiser preservar edições.

## Estendendo

**Novo tipo de componente:**
1. Adiciona em `BUILDER_TYPES` (server.js? Não — só `public/index.html`): `{ tag, base }`
2. Em `BUILDER_PALETTE_ICONS`: ícone
3. Em `builderMakeNode`: defaults
4. Em `BUILDER_TYPES` do componente JBuilderPage runtime (re-instale Runtime depois)
5. Se aceita texto: adiciona em `supportsText` na props panel
6. Se aceita filhos: adiciona em `builderTypeSupportsChildren`

**Nova action de workflow:**
1. Em `BUILDER_ACTION_TYPES`: `{ label, fields: [...] }`
2. Em `builderEmitActionJs` (export): handler JSX
3. No runtime (`runActions`): handler runtime
