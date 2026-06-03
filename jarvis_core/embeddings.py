"""Semantic search no hub via embeddings locais (Ollama nomic-embed-text).

Index armazenado em ~/.cache/jarvis/hub-index.json:
{
  "model": "nomic-embed-text",
  "items": [
    {"path": "snippets/x.md", "mtime": 1234, "vector": [0.1, ...], "text": "..."}
  ]
}

Re-indexa só arquivos modificados (mtime check). Search é cosine similarity em memória.
"""
import json
import math
import os
import re
import time
from pathlib import Path
from typing import Any

import aiohttp

HUB = Path.home() / "dev" / "_hub"
INDEX_PATH = Path.home() / ".cache" / "jarvis" / "hub-index.json"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
EMBED_MODEL = os.environ.get("JARVIS_EMBED_MODEL", "nomic-embed-text")

# Folders we index
INDEX_FOLDERS = ["snippets", "padroes", "decisoes", "projetos", "conversas", "macros", "memorias", "planos", "usuario"]
MAX_CHARS = 4000


def _strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end > 0:
            return text[end + 4:].lstrip("\n")
    return text


def _walk_hub() -> list[dict]:
    """Returns list of {path, mtime, text} for indexable .md files."""
    out = []
    for folder in INDEX_FOLDERS:
        d = HUB / folder
        if not d.exists():
            continue
        for p in d.glob("**/*.md"):
            try:
                stat = p.stat()
                content = p.read_text(encoding="utf-8", errors="ignore")
                content = _strip_frontmatter(content)[:MAX_CHARS]
                out.append({
                    "path": str(p.relative_to(HUB)),
                    "mtime": int(stat.st_mtime),
                    "text": content,
                })
            except Exception:
                continue
    return out


def _load_index() -> dict[str, Any]:
    if not INDEX_PATH.exists():
        return {"model": EMBED_MODEL, "items": []}
    try:
        return json.loads(INDEX_PATH.read_text())
    except Exception:
        return {"model": EMBED_MODEL, "items": []}


def _save_index(idx: dict) -> None:
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps(idx, ensure_ascii=False))


async def _embed(session: aiohttp.ClientSession, text: str) -> list[float] | None:
    try:
        async with session.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": EMBED_MODEL, "prompt": text},
            timeout=aiohttp.ClientTimeout(total=30),
        ) as r:
            if r.status != 200:
                return None
            d = await r.json()
            return d.get("embedding")
    except Exception:
        return None


async def reindex(force: bool = False) -> dict[str, int]:
    """Walk hub, embed new/modified files, save index. Returns counts."""
    idx = _load_index()
    if idx.get("model") != EMBED_MODEL:
        idx = {"model": EMBED_MODEL, "items": []}
        force = True

    by_path = {it["path"]: it for it in idx["items"]}
    current = _walk_hub()
    current_paths = {it["path"] for it in current}

    new_count = updated_count = skipped = removed = 0

    async with aiohttp.ClientSession() as session:
        for it in current:
            existing = by_path.get(it["path"])
            if not force and existing and existing.get("mtime") == it["mtime"] and existing.get("vector"):
                skipped += 1
                continue
            vec = await _embed(session, it["text"])
            if vec is None:
                continue
            entry = {
                "path": it["path"],
                "mtime": it["mtime"],
                "vector": vec,
                "text": it["text"][:600],  # snippet only, keep index small
            }
            if existing:
                by_path[it["path"]] = entry
                updated_count += 1
            else:
                by_path[it["path"]] = entry
                new_count += 1

    # Drop entries for files that were deleted
    for p in list(by_path.keys()):
        if p not in current_paths:
            del by_path[p]
            removed += 1

    idx["items"] = list(by_path.values())
    _save_index(idx)

    return {
        "total": len(idx["items"]),
        "new": new_count,
        "updated": updated_count,
        "skipped": skipped,
        "removed": removed,
    }


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


async def semantic_search(query: str, top_k: int = 5,
                          min_score: float = 0.4) -> list[dict]:
    """Returns list of {path, score, snippet} sorted by similarity desc."""
    idx = _load_index()
    if not idx.get("items"):
        return []
    async with aiohttp.ClientSession() as session:
        qvec = await _embed(session, query)
    if qvec is None:
        return []
    scored = []
    for it in idx["items"]:
        vec = it.get("vector")
        if not vec:
            continue
        score = _cosine(qvec, vec)
        if score >= min_score:
            scored.append({
                "path": it["path"],
                "score": round(score, 3),
                "snippet": it.get("text", "")[:300],
                "title": Path(it["path"]).stem,
            })
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_k]


async def health() -> dict:
    """Quick check: Ollama up + model present."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{OLLAMA_URL}/api/tags",
                                    timeout=aiohttp.ClientTimeout(total=3)) as r:
                if r.status != 200:
                    return {"ok": False, "reason": "ollama down"}
                d = await r.json()
                models = [m["name"] for m in d.get("models", [])]
                has = any(m.startswith(EMBED_MODEL) for m in models)
                return {
                    "ok": has,
                    "model": EMBED_MODEL,
                    "modelPresent": has,
                    "indexedFiles": len(_load_index().get("items", [])),
                    "indexPath": str(INDEX_PATH),
                }
    except Exception as e:
        return {"ok": False, "reason": str(e)}
