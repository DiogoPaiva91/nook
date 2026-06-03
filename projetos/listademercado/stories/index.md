# Stories — Lista de Mercado v1

**Autor:** Bob (SM)
**Data:** 2026-04-26
**Fontes:** prd.md §6 (épicos e ACs) + architecture.md (dev notes técnicas)
**Status global:** todas Done (código já em `src/`).

Este diretório contém os **story files dev-ready** da v1, derivados do PRD e da arquitetura. Cada arquivo é autocontido — um dev (humano ou agente) consegue executar a story só com o que está no documento.

## Convenção de nome
`<épico>.<story>.<slug-curto>.md` — espelha o ID do PRD §6.

## Stories

| ID | Título | Épico | Status | Arquivo |
|---|---|---|---|---|
| 1.1 | Adicionar item | CRUD | Done | [1.1.adicionar-item.md](1.1.adicionar-item.md) |
| 1.2 | Marcar como comprado | CRUD | Done | [1.2.marcar-comprado.md](1.2.marcar-comprado.md) |
| 1.3 | Remover item | CRUD | Done | [1.3.remover-item.md](1.3.remover-item.md) |
| 1.4 | Limpar lista | CRUD | Done | [1.4.limpar-lista.md](1.4.limpar-lista.md) |
| 2.1 | Persistência em localStorage | Persistência | Done | [2.1.persistencia-localstorage.md](2.1.persistencia-localstorage.md) |
| 3.1 | Estado vazio | Feedback | Done | [3.1.estado-vazio.md](3.1.estado-vazio.md) |
| 3.2 | Contador | Feedback | Done | [3.2.contador.md](3.2.contador.md) |

## Ordem sugerida (caso re-implementasse do zero)
1. **2.1** primeiro — define o contrato de persistência usado por todas as outras.
2. **1.1** — adicionar é a entrada do funil; sem ela, nada para testar nas demais.
3. **3.1** + **3.2** — feedback visual depende de ter pelo menos a story 1.1 funcionando.
4. **1.2**, **1.3**, **1.4** — operam sobre itens já existentes.

## Observação
A v1 já está implementada (ver `src/` e `architecture.md` §16). Estes documentos formalizam retroativamente o backlog da SM, fechando a fase. Para v2, o PM reabrirá o backlog (PRD §8) e o SM gerará novas stories a partir dele.
