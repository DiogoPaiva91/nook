"""Enriquece prompts com contexto do hub Obsidian.

Estratégia híbrida:
- Tenta busca semântica via embeddings (Ollama nomic-embed-text). Quando funciona,
  pega notas semanticamente próximas mesmo com sinônimos.
- Fallback pra substring (obsidian_bridge.get_context_for_project) se Ollama down
  ou se o índice ainda não foi construído.

`enrich_prompt` é síncrono pra manter API estável; usa asyncio.run pra chamar
o async semantic_search internamente.
"""
import asyncio
import os
from pathlib import Path
from jarvis_core.obsidian_bridge import get_context_for_project, list_all

# Modos que NÃO recebem contexto (chats triviais)
MODES_WITHOUT_CONTEXT = {"chat"}

PROFILE_PATH = Path.home() / "dev" / "_hub" / "usuario" / "perfil.md"


def read_user_profile() -> str:
    try:
        if not PROFILE_PATH.exists():
            return ""
        content = PROFILE_PATH.read_text(encoding="utf-8", errors="ignore")
        # Strip frontmatter
        if content.startswith("---"):
            end = content.find("\n---", 3)
            if end > 0:
                content = content[end + 4:].lstrip("\n")
        return content[:4000]
    except Exception:
        return ""


def _semantic_context(query: str) -> str:
    """Returns formatted hub context using semantic search; empty if unavailable."""
    try:
        from jarvis_core.embeddings import semantic_search
    except Exception:
        return ""
    try:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop and loop.is_running():
            # Already inside async context — caller should use async path.
            return ""
        results = asyncio.run(semantic_search(query, top_k=4, min_score=0.55))
    except Exception:
        return ""
    if not results:
        return ""
    parts = []
    for r in results:
        parts.append(f"### {r['title']} ({r['path']}) [similar={r['score']}]\n{r['snippet']}\n")
    return "## Contexto do hub (semântico):\n\n" + "\n".join(parts)


async def _semantic_context_async(query: str) -> str:
    try:
        from jarvis_core.embeddings import semantic_search
        results = await semantic_search(query, top_k=4, min_score=0.55)
    except Exception:
        return ""
    if not results:
        return ""
    parts = []
    for r in results:
        parts.append(f"### {r['title']} ({r['path']}) [similar={r['score']}]\n{r['snippet']}\n")
    return "## Contexto do hub (semântico):\n\n" + "\n".join(parts)


async def enrich_prompt_async(user_prompt: str, agent: str | None = None, mode: str | None = None) -> str:
    if mode and mode.lower() in MODES_WITHOUT_CONTEXT and not agent:
        return user_prompt
    context = await _semantic_context_async(user_prompt)
    if not context:
        # Fallback to substring search
        context = get_context_for_project(user_prompt)
    if not context:
        return user_prompt
    return (
        f"{context}\n\n---\n\n## Tarefa do usuário:\n\n{user_prompt}\n\n---\n\n"
        "INSTRUÇÃO: Use o contexto acima quando relevante. Se aplicar padrão/decisão "
        "prévia, mencione. Se identificar algo novo que vale virar ADR/padrão/snippet, "
        "sinalize."
    )


def enrich_prompt(user_prompt: str, agent: str | None = None, mode: str | None = None) -> str:
    if mode and mode.lower() in MODES_WITHOUT_CONTEXT and not agent:
        return user_prompt
    context = _semantic_context(user_prompt)
    if not context:
        context = get_context_for_project(user_prompt)
    if not context:
        return user_prompt
    return (
        f"{context}\n\n---\n\n## Tarefa do usuário:\n\n{user_prompt}\n\n---\n\n"
        "INSTRUÇÃO: Use o contexto acima quando relevante. Se aplicar padrão/decisão "
        "prévia, mencione. Se identificar algo novo que vale virar ADR/padrão/snippet, "
        "sinalize."
    )


def get_hub_summary() -> str:
    cats = list_all()
    s = "## Hub disponível:\n"
    for cat, items in cats.items():
        s += f"- **{cat}** ({len(items)}): {', '.join(items[:3])}"
        if len(items) > 3:
            s += f", +{len(items) - 3}"
        s += "\n"
    return s
