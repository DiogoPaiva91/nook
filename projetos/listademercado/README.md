# Lista de Mercado

App client-side para montar lista de compras. Vanilla HTML/CSS/JS, persistencia em `localStorage`.

## Como rodar

Por usar modulos ES nativos (`<script type="module">`), o navegador exige servir via HTTP — abrir `index.html` direto (`file://`) nao funciona.

```bash
# da raiz do projeto
cd projetos/listademercado
python3 -m http.server 8000
# abrir http://localhost:8000
```

Alternativas: `npx serve`, `npx http-server`, ou qualquer servidor estatico.

## Estrutura

```
index.html          entry + estrutura semantica
styles/main.css     tokens + layout mobile-first
src/
  main.js           bootstrap + event handlers
  store.js          estado + acoes (add/toggle/remove/clear)
  storage.js        wrapper localStorage (load/save)
  render.js         renderiza lista, contador, estado vazio
```

## Stories implementadas

- 1.1 Adicionar item
- 1.2 Marcar como comprado
- 1.3 Remover item
- 1.4 Limpar lista (com confirmacao)
- 2.1 Persistencia em localStorage (chave `listademercado.v1`)
- 3.1 Estado vazio
- 3.2 Contador `X de Y itens`
