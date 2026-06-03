"""Bridge entre Jarvis e Obsidian vault (~/dev/_hub)."""
from pathlib import Path
from datetime import date
import re

HUB = Path.home() / "dev" / "_hub"


def list_folder(folder: str) -> list[str]:
    p = HUB / folder
    return sorted([f.stem for f in p.glob("*.md")]) if p.exists() else []


def read_note(rel_path: str) -> str:
    p = HUB / f"{rel_path}.md"
    return p.read_text(encoding="utf-8") if p.exists() else ""


def build_graph(folders: list[str] | None = None, max_files: int = 500) -> dict:
    """Constrói nodes + edges para uma view de grafo do hub.

    Nodes vêm de qualquer .md em folders (default: snippets/padroes/decisoes/projetos/conversas/macros).
    Edges saem de wikilinks `[[Nome]]` ou `[[caminho|alias]]` no body de cada arquivo.
    """
    folders = folders or ["snippets", "padroes", "decisoes", "projetos", "conversas", "macros"]
    nodes: dict[str, dict] = {}
    # Map basename → relative path for resolving [[link]] without folder
    by_stem: dict[str, str] = {}
    md_files: list[Path] = []
    for folder in folders:
        fp = HUB / folder
        if not fp.exists():
            continue
        for md in fp.glob("**/*.md"):
            if md.is_file():
                md_files.append(md)
    md_files = md_files[:max_files]

    for md in md_files:
        rel = str(md.relative_to(HUB).with_suffix(""))
        nid = rel
        nodes[nid] = {
            "id": nid,
            "title": md.stem,
            "folder": rel.split("/", 1)[0] if "/" in rel else "",
            "outDegree": 0,
            "inDegree": 0,
        }
        by_stem.setdefault(md.stem.lower(), nid)

    edges: list[dict] = []
    seen: set[tuple[str, str]] = set()
    link_re = re.compile(r"\[\[([^\]\|#]+?)(?:#[^\]]*)?(?:\|[^\]]*)?\]\]")
    for md in md_files:
        try:
            content = md.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        src = str(md.relative_to(HUB).with_suffix(""))
        for m in link_re.finditer(content):
            target = m.group(1).strip()
            # Resolve: if has slash, use as-is; else look up by stem
            tgt_id: str | None = None
            if "/" in target:
                if target in nodes:
                    tgt_id = target
            else:
                tgt_id = by_stem.get(target.lower())
            if not tgt_id or tgt_id == src:
                continue
            key = (src, tgt_id)
            if key in seen:
                continue
            seen.add(key)
            edges.append({"source": src, "target": tgt_id})
            nodes[src]["outDegree"] += 1
            nodes[tgt_id]["inDegree"] += 1
    return {
        "nodes": list(nodes.values()),
        "edges": edges,
        "stats": {
            "totalFiles": len(md_files),
            "totalEdges": len(edges),
            "isolated": sum(1 for n in nodes.values() if n["outDegree"] == 0 and n["inDegree"] == 0),
        },
    }


def search_hub(query: str, folders: list[str] | None = None) -> list[dict]:
    folders = folders or ["snippets", "padroes", "decisoes", "projetos"]
    results, q = [], query.lower()
    for folder in folders:
        fp = HUB / folder
        if not fp.exists():
            continue
        for md in fp.glob("**/*.md"):
            content = md.read_text(encoding="utf-8", errors="ignore")
            if q in content.lower():
                lines = content.split("\n")
                for i, line in enumerate(lines):
                    if q in line.lower():
                        snip = "\n".join(lines[max(0, i - 1):min(len(lines), i + 2)])
                        results.append({
                            "path": str(md.relative_to(HUB)),
                            "title": md.stem,
                            "snippet": snip[:300],
                        })
                        break
    return results


def get_context_for_project(descricao: str) -> str:
    keywords = [w for w in re.findall(r"\w+", descricao.lower()) if len(w) > 4]
    parts, seen = [], set()
    for kw in keywords[:5]:
        for r in search_hub(kw)[:3]:
            if r["path"] in seen:
                continue
            seen.add(r["path"])
            parts.append(f"### {r['title']} ({r['path']})\n{r['snippet']}\n")
    return "## Contexto do hub:\n\n" + "\n".join(parts) if parts else ""


def _slug(text: str) -> str:
    return re.sub(r"[-\s]+", "-", re.sub(r"[^\w\s-]", "", text.lower())).strip("-")


def _try_template(name: str) -> str | None:
    p = HUB / "templates" / f"{name}.md"
    return p.read_text(encoding="utf-8") if p.exists() else None


def _render_template(template_text: str, *, title: str,
                     frontmatter: dict[str, str] | None = None,
                     sections: dict[str, str] | None = None) -> str:
    """Render an Obsidian Templater-style template.

    - Replaces `<% tp.file.title %>` and `<% tp.date.now(...) %>` tokens.
    - Strips any other unknown `<% ... %>` tokens.
    - For each frontmatter key, fills the corresponding empty `key:` line.
      Adds the line if missing (just before the closing `---`).
    - For each section, appends body under the matching `## Header` line
      (prefix match, so "Alternativas" matches "## Alternativas consideradas").
    """
    today = date.today().isoformat()
    out = template_text.replace("<% tp.file.title %>", title)
    out = re.sub(r"<%\s*tp\.date\.now\s*\([^)]*\)\s*%>", today, out)
    out = re.sub(r"<%[^%]*%>", "", out)

    fm = frontmatter or {}
    for key, value in fm.items():
        if not value:
            continue
        new_line = f"{key}: {value}"
        # Fill existing empty "key:" line
        pattern = re.compile(rf"^({re.escape(key)}):\s*$", re.MULTILINE)
        if pattern.search(out):
            out = pattern.sub(new_line, out, count=1)
        else:
            # Insert as a new line just before the closing frontmatter delimiter
            out = re.sub(
                r"(^---\s*\n[\s\S]*?\n)(---\s*$)",
                lambda m: m.group(1) + new_line + "\n" + m.group(2),
                out, count=1, flags=re.MULTILINE,
            )

    for header_name, body in (sections or {}).items():
        if not body:
            continue
        pattern = re.compile(
            r"(^##\s+" + re.escape(header_name) + r"[^\n]*\n)([\s\S]*?)(?=\n##|\Z)",
            re.MULTILINE,
        )
        out = pattern.sub(lambda m: m.group(1) + body.rstrip() + "\n\n", out, count=1)

    return out


def _merge_tags(default: list[str], extra: list[str] | None) -> str:
    seen, out = set(), []
    for t in default + (extra or []):
        t = (t or "").strip().lower()
        if not t or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return "[" + ", ".join(out) + "]"


def write_adr(title: str, projeto: str, contexto: str, decisao: str,
              consequencias: str, alternativas: str = "",
              tags: list[str] | None = None) -> str:
    today = date.today().isoformat()
    path = HUB / "decisoes" / f"{today}-{_slug(title)}.md"
    path.parent.mkdir(parents=True, exist_ok=True)

    template = _try_template("adr")
    if template:
        content = _render_template(
            template,
            title=title,
            frontmatter={"projeto": projeto, **({"tags": _merge_tags(["adr", "decisao"], tags)} if tags else {})},
            sections={
                "Contexto": contexto,
                "Decisão": decisao,
                "Consequências": consequencias,
                "Alternativas": alternativas,
            },
        )
    else:
        merged_tags = _merge_tags(["adr", "decisao"], tags)
        content = (
            f"---\ndata: {today}\nprojeto: {projeto}\nstatus: proposto\n"
            f"tags: {merged_tags}\n---\n\n# ADR — {title}\n\n## Contexto\n{contexto}\n\n"
            f"## Decisão\n{decisao}\n\n## Consequências\n{consequencias}\n\n"
            f"## Alternativas\n{alternativas}\n"
        )
    path.write_text(content, encoding="utf-8")
    return str(path.relative_to(HUB))


def write_snippet(title: str, linguagem: str, contexto: str, codigo: str,
                  projeto_origem: str = "", tags: list[str] | None = None) -> str:
    path = HUB / "snippets" / f"{_slug(title)}.md"
    path.parent.mkdir(parents=True, exist_ok=True)

    template = _try_template("snippet")
    if template:
        content = _render_template(
            template,
            title=title,
            frontmatter={
                "linguagem": linguagem,
                "contexto": contexto,
                "projeto_origem": projeto_origem,
                **({"tags": _merge_tags(["snippet"], tags)} if tags else {}),
            },
            sections={"Quando usar": contexto},
        )
        # Snippet template has an empty fenced block — fill it with the code.
        content = re.sub(
            r"```\s*\n\s*\n```",
            f"```{linguagem}\n{codigo}\n```",
            content,
            count=1,
        )
    else:
        merged_tags = _merge_tags(["snippet"], tags)
        content = (
            f"---\nlinguagem: {linguagem}\ncontexto: {contexto}\n"
            f"projeto_origem: {projeto_origem}\ntags: {merged_tags}\n---\n\n# {title}\n\n"
            f"## Quando usar\n{contexto}\n\n## Código\n```{linguagem}\n{codigo}\n```\n"
        )
    path.write_text(content, encoding="utf-8")
    return str(path.relative_to(HUB))


def write_padrao(title: str, categoria: str, stack: str, problema: str,
                 solucao: str, tags: list[str] | None = None) -> str:
    path = HUB / "padroes" / f"{_slug(title)}.md"
    path.parent.mkdir(parents=True, exist_ok=True)

    template = _try_template("padrao")
    if template:
        content = _render_template(
            template,
            title=title,
            frontmatter={
                "categoria": categoria, "stack": stack,
                **({"tags": _merge_tags(["padrao"], tags)} if tags else {}),
            },
            sections={"Problema": problema, "Solução": solucao},
        )
    else:
        merged_tags = _merge_tags(["padrao"], tags)
        content = (
            f"---\ncategoria: {categoria}\nstack: {stack}\ntags: {merged_tags}\n---\n\n"
            f"# {title}\n\n## Problema\n{problema}\n\n## Solução\n{solucao}\n"
        )
    path.write_text(content, encoding="utf-8")
    return str(path.relative_to(HUB))


def update_projeto_index(nome: str, descricao: str = "") -> str:
    idx = HUB / "projetos" / "index.md"
    idx.parent.mkdir(parents=True, exist_ok=True)
    if not idx.exists():
        idx.write_text("# 🚀 Projetos\n\n", encoding="utf-8")
    today = date.today().isoformat()
    with open(idx, "a", encoding="utf-8") as f:
        f.write(f"- [[../../projetos/{nome}/README|{nome}]] — {descricao} ({today})\n")
    return str(idx.relative_to(HUB))


def list_all() -> dict[str, list[str]]:
    return {
        "snippets": list_folder("snippets"),
        "padroes": list_folder("padroes"),
        "decisoes": list_folder("decisoes"),
        "projetos": list_folder("projetos"),
    }


# ============= BMAD ARTIFACTS =============

PROJETOS_DIR_BASE = Path.home() / "dev" / "projetos"  # actual code projects
HUB_PROJETOS_DIR = HUB / "projetos"  # hub-side artifacts/index

BMAD_KIND_TO_AGENT = {
    "brief": "analyst",
    "prd": "pm",
    "architecture": "architect",
    "stories": "sm",
    "implementation": "dev",
    "qa-report": "qa",
}

VALID_BMAD_KINDS = set(BMAD_KIND_TO_AGENT.keys())


def list_projetos() -> list[str]:
    """List project directories under ~/dev/projetos and the special 'jarvis' itself."""
    out: list[str] = []
    if PROJETOS_DIR_BASE.exists():
        for p in sorted(PROJETOS_DIR_BASE.iterdir()):
            if p.is_dir() and not p.name.startswith("."):
                out.append(p.name)
    return out


def write_bmad_artifact(projeto: str, kind: str, content: str,
                        title: str | None = None,
                        agent: str | None = None) -> dict:
    """Write a BMAD artifact for a project.

    Saves TWO copies:
      1. Inside the project itself: ~/dev/projetos/<projeto>/docs/<kind>.md
         (or ~/dev/jarvis/docs/<kind>.md for the special "jarvis" project)
      2. A pointer/snapshot in the hub: _hub/projetos/<projeto>/<kind>.md
    """
    if kind not in VALID_BMAD_KINDS:
        raise ValueError(f"kind inválido: {kind}. Use: {sorted(VALID_BMAD_KINDS)}")
    if not projeto:
        raise ValueError("projeto vazio")

    today = date.today().isoformat()
    title = title or f"{kind.upper()} - {projeto}"
    agent = agent or BMAD_KIND_TO_AGENT.get(kind, "")

    # Resolve project root on disk
    proj_root: Path
    if projeto == "jarvis":
        proj_root = Path.home() / "dev" / "jarvis"
    else:
        proj_root = PROJETOS_DIR_BASE / projeto
    project_exists = proj_root.exists()

    body = (
        f"---\n"
        f"projeto: {projeto}\n"
        f"kind: {kind}\n"
        f"agent: {agent}\n"
        f"updated: {today}\n"
        f"tags: [bmad, {kind}]\n"
        f"---\n\n"
        f"# {title}\n\n{content.strip()}\n"
    )

    written: list[str] = []

    if project_exists:
        proj_docs = proj_root / "docs"
        proj_docs.mkdir(parents=True, exist_ok=True)
        proj_file = proj_docs / f"{kind}.md"
        proj_file.write_text(body, encoding="utf-8")
        written.append(str(proj_file))

    hub_proj = HUB_PROJETOS_DIR / projeto
    hub_proj.mkdir(parents=True, exist_ok=True)
    hub_file = hub_proj / f"{kind}.md"
    hub_file.write_text(body, encoding="utf-8")
    written.append(str(hub_file.relative_to(HUB)))

    return {
        "projeto": projeto,
        "kind": kind,
        "agent": agent,
        "written": written,
        "projectFound": project_exists,
    }


# ============= MACROS (browser automation) =============

MACROS_DIR = HUB / "macros"
MACROS_VERSIONS_DIR = HUB / "macros" / ".versions"
MACROS_VERSIONS_KEEP = 10  # keep last 10 versions per macro


def _parse_macro_file(path: Path) -> dict:
    """Macro file format: YAML-ish frontmatter + markdown sections.

    ---
    name: Lançar ponto
    slug: lancar-ponto
    created: 2026-04-26
    updated: 2026-04-26
    procedure_chars: 320
    ---

    ## Procedimento
    <text>

    ## Mensagens originais (opcional)
    1. ...

    ## Steps gravados (opcional)
    - ...
    """
    text = path.read_text(encoding="utf-8")
    fm: dict[str, str] = {}
    body = text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end > 0:
            block = text[3:end].strip()
            body = text[end + 4:].lstrip("\n")
            for line in block.splitlines():
                if ":" in line:
                    k, _, v = line.partition(":")
                    fm[k.strip()] = v.strip()

    procedure = ""
    user_messages: list[str] = []
    pm = re.search(r"^##\s+Procedimento\s*\n([\s\S]*?)(?=\n##|\Z)", body, re.MULTILINE)
    if pm:
        procedure = pm.group(1).strip()
    um = re.search(r"^##\s+Mensagens originais\s*\n([\s\S]*?)(?=\n##|\Z)", body, re.MULTILINE)
    if um:
        for line in um.group(1).strip().splitlines():
            line = line.strip()
            if not line:
                continue
            line = re.sub(r"^\d+[\.)]\s*", "", line)
            line = re.sub(r"^[-*]\s*", "", line)
            user_messages.append(line)

    chains_raw = fm.get("chains", "")
    chains = [c.strip() for c in chains_raw.split(",") if c.strip()] if chains_raw else []
    return {
        "slug": fm.get("slug") or path.stem,
        "name": fm.get("name") or path.stem,
        "created": fm.get("created", ""),
        "updated": fm.get("updated", ""),
        "schedule": fm.get("schedule", ""),
        "lastRun": fm.get("lastRun", ""),
        "lastError": fm.get("lastError", ""),
        "lastDurationMs": fm.get("lastDurationMs", ""),
        "runs": fm.get("runs", "0"),
        "fails": fm.get("fails", "0"),
        "avgDurationMs": fm.get("avgDurationMs", "0"),
        "runHistory": fm.get("runHistory", ""),
        "chains": chains,
        "skipIf": fm.get("skipIf", ""),
        "procedure": procedure,
        "userMessages": user_messages,
    }


def list_macros() -> list[dict]:
    if not MACROS_DIR.exists():
        return []
    out = []
    for p in sorted(MACROS_DIR.glob("*.md")):
        try:
            m = _parse_macro_file(p)
            params = sorted(set(re.findall(r"\{(\w+)\}", m.get("procedure") or "")))
            def _i(v):
                try: return int(v or 0)
                except Exception: return 0
            out.append({
                "slug": m["slug"],
                "name": m["name"],
                "updated": m["updated"],
                "schedule": m.get("schedule") or "",
                "lastRun": m.get("lastRun") or "",
                "lastError": m.get("lastError") or "",
                "lastDurationMs": _i(m.get("lastDurationMs")),
                "runs": _i(m.get("runs")),
                "fails": _i(m.get("fails")),
                "avgDurationMs": _i(m.get("avgDurationMs")),
                "runHistory": m.get("runHistory") or "",
                "stepCount": len(m["userMessages"]),
                "params": params,
                "chains": m.get("chains") or [],
                "skipIf": m.get("skipIf") or "",
            })
        except Exception:
            continue
    return out


def get_macro(slug: str) -> dict | None:
    p = MACROS_DIR / f"{slug}.md"
    if not p.exists():
        return None
    return _parse_macro_file(p)


def save_macro(name: str, procedure: str, user_messages: list[str] | None = None,
               steps: list[dict] | None = None, slug: str | None = None,
               schedule: str | None = None, last_run: str | None = None,
               last_error: str | None = None, last_duration_ms: int | None = None,
               run_outcome: str | None = None,
               chains: list[str] | None = None, skip_if: str | None = None) -> dict:
    """run_outcome: 'ok' | 'fail' | None. If set, increments counters and history."""
    import time as _t
    MACROS_DIR.mkdir(parents=True, exist_ok=True)
    slug = slug or _slug(name) or "macro"
    today = date.today().isoformat()
    path = MACROS_DIR / f"{slug}.md"
    # Backup existing file before any overwrite (skip if only stat update)
    if path.exists() and procedure and procedure.strip():
        try:
            existing_text = path.read_text(encoding="utf-8")
            # Only version when procedure actually changed (avoid creating versions
            # on every cron run that just updates lastRun/stats)
            existing_proc = ""
            pm = re.search(r"^##\s+Procedimento\s*\n([\s\S]*?)(?=\n##|\Z)", existing_text, re.MULTILINE)
            if pm:
                existing_proc = pm.group(1).strip()
            if existing_proc and existing_proc != procedure.strip():
                vdir = MACROS_VERSIONS_DIR / slug
                vdir.mkdir(parents=True, exist_ok=True)
                ts = _t.strftime("%Y%m%d-%H%M%S")
                (vdir / f"{ts}.md").write_text(existing_text, encoding="utf-8")
                # Prune to MACROS_VERSIONS_KEEP
                versions = sorted(vdir.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
                for old in versions[MACROS_VERSIONS_KEEP:]:
                    try: old.unlink()
                    except Exception: pass
        except Exception:
            pass
    created = today
    existing_schedule = ""
    existing_last_run = ""
    existing_last_error = ""
    existing_last_duration = ""
    existing_runs = 0
    existing_fails = 0
    existing_avg = 0
    existing_history = ""
    existing_chains: list[str] = []
    existing_skip_if = ""

    def _i(v: str) -> int:
        try: return int(v or 0)
        except Exception: return 0

    if path.exists():
        existing = _parse_macro_file(path)
        created = existing.get("created") or today
        existing_schedule = existing.get("schedule") or ""
        existing_last_run = existing.get("lastRun") or ""
        existing_last_error = existing.get("lastError") or ""
        existing_last_duration = existing.get("lastDurationMs") or ""
        existing_runs = _i(existing.get("runs"))
        existing_fails = _i(existing.get("fails"))
        existing_avg = _i(existing.get("avgDurationMs"))
        existing_history = existing.get("runHistory") or ""
        existing_chains = existing.get("chains") or []
        existing_skip_if = existing.get("skipIf") or ""

    # Preserve existing fields unless explicitly updated
    final_schedule = schedule if schedule is not None else existing_schedule
    final_last_run = last_run if last_run is not None else existing_last_run
    final_last_error = last_error if last_error is not None else existing_last_error
    final_last_duration = (
        str(last_duration_ms) if last_duration_ms is not None else existing_last_duration
    )
    final_chains = chains if chains is not None else existing_chains
    final_skip_if = skip_if if skip_if is not None else existing_skip_if

    # Stats: only update when run_outcome explicitly set
    final_runs = existing_runs
    final_fails = existing_fails
    final_avg = existing_avg
    final_history = existing_history
    if run_outcome in ("ok", "fail"):
        final_runs = existing_runs + 1
        if run_outcome == "fail":
            final_fails = existing_fails + 1
        # Running average duration (only update when we have a duration)
        if last_duration_ms is not None and last_duration_ms > 0:
            final_avg = int(((existing_avg * existing_runs) + last_duration_ms) / final_runs)
        # History: comma-separated 1/0, last 20 entries (most recent first)
        token = "1" if run_outcome == "ok" else "0"
        items = [token] + ([s for s in existing_history.split(",") if s] if existing_history else [])
        final_history = ",".join(items[:20])

    msgs_block = ""
    if user_messages:
        lines = [f"{i + 1}. {m}" for i, m in enumerate(user_messages)]
        msgs_block = "\n## Mensagens originais\n\n" + "\n".join(lines) + "\n"

    steps_block = ""
    if steps:
        lines = []
        for s in steps:
            tool = (s.get("tool") or "").replace("mcp__jarvis-browser__", "")
            ok = "✓" if s.get("ok", True) else "✗"
            inp = s.get("input") or {}
            inp_str = " ".join(f"{k}={v!r}" for k, v in inp.items())[:200]
            lines.append(f"- {ok} `{tool}` {inp_str}")
        steps_block = "\n## Steps gravados\n\n" + "\n".join(lines) + "\n"

    fm_lines = [
        f"name: {name}",
        f"slug: {slug}",
        f"created: {created}",
        f"updated: {today}",
        "tags: [macro, browser]",
    ]
    if final_schedule:
        fm_lines.append(f"schedule: {final_schedule}")
    if final_last_run:
        fm_lines.append(f"lastRun: {final_last_run}")
    if final_last_error:
        # Strip newlines so frontmatter stays single-line per field
        clean = final_last_error.replace("\n", " ")[:300]
        fm_lines.append(f"lastError: {clean}")
    if final_last_duration:
        fm_lines.append(f"lastDurationMs: {final_last_duration}")
    if final_runs:
        fm_lines.append(f"runs: {final_runs}")
    if final_fails:
        fm_lines.append(f"fails: {final_fails}")
    if final_avg:
        fm_lines.append(f"avgDurationMs: {final_avg}")
    if final_history:
        fm_lines.append(f"runHistory: {final_history}")
    if final_chains:
        fm_lines.append(f"chains: {', '.join(final_chains)}")
    if final_skip_if:
        # Strip newlines so frontmatter stays single-line
        fm_lines.append(f"skipIf: {final_skip_if.replace(chr(10), ' ')[:200]}")

    content = (
        "---\n" + "\n".join(fm_lines) + "\n---\n\n"
        f"# {name}\n\n## Procedimento\n\n"
        f"{procedure.strip()}\n{msgs_block}{steps_block}"
    )
    path.write_text(content, encoding="utf-8")
    return _parse_macro_file(path)


def list_macro_versions(slug: str) -> list[dict]:
    vdir = MACROS_VERSIONS_DIR / slug
    if not vdir.exists():
        return []
    out = []
    for p in sorted(vdir.glob("*.md"), reverse=True):
        try:
            stat = p.stat()
            out.append({
                "id": p.stem,
                "size": stat.st_size,
                "mtime": int(stat.st_mtime),
            })
        except Exception:
            continue
    return out


def get_macro_version(slug: str, version_id: str) -> dict | None:
    """Parse a versioned macro file (without overwriting current)."""
    if "/" in version_id or ".." in version_id:
        return None
    p = MACROS_VERSIONS_DIR / slug / f"{version_id}.md"
    if not p.exists():
        return None
    return _parse_macro_file(p)


def restore_macro_version(slug: str, version_id: str) -> dict | None:
    """Restore a previous version. Current state gets versioned by save_macro."""
    if "/" in version_id or ".." in version_id:
        return None
    src = MACROS_VERSIONS_DIR / slug / f"{version_id}.md"
    if not src.exists():
        return None
    parsed = _parse_macro_file(src)
    return save_macro(
        name=parsed["name"], procedure=parsed["procedure"],
        user_messages=parsed.get("userMessages") or [], slug=slug,
        schedule=parsed.get("schedule") or "",
        chains=parsed.get("chains") or [],
        skip_if=parsed.get("skipIf") or "",
    )


def delete_macro(slug: str) -> bool:
    p = MACROS_DIR / f"{slug}.md"
    if not p.exists():
        return False
    p.unlink()
    return True
