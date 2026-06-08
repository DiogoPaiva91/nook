"""HTTP sidecar (porta 3001): expõe Agent SDK + BMAD + hub para o Node Nook."""
import asyncio
import json
import os
import re
import sys
import traceback
from pathlib import Path

from aiohttp import web

# Ensure nook_core is importable when run as `python -m nook_core.server`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from claude_agent_sdk import (  # noqa: E402
    query,
    ClaudeAgentOptions,
    AssistantMessage,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
    ResultMessage,
)

from nook_core.chat_sdk import handle_sdk_chat, handle_sdk_permission  # noqa: E402
from nook_core.bmad_loader import load_agent, list_agents  # noqa: E402
from nook_core.agent_context import enrich_prompt, enrich_prompt_async, get_hub_summary, read_user_profile  # noqa: E402
from nook_core import embeddings as embed  # noqa: E402
from nook_core import obsidian_bridge as hub  # noqa: E402
from nook_core.browser import (  # noqa: E402
    make_browser_mcp, BROWSER_TOOL_NAMES,
    MANUAL_SESSION, SCHEDULED_SESSION,
)

PORT = int(os.environ.get("NOOK_CORE_PORT", "3001"))

MODE_TOOLS = {
    "chat": [],
    "cowork": ["Bash", "Read", "Write", "Glob", "Grep", "WebFetch", "WebSearch"],
    "browser": BROWSER_TOOL_NAMES,
    "codigo": [
        "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
    ],
}

DEFAULT_PROMPTS = {
    "chat": (
        "Você é Nook no MODO CHAT. Conversação rápida, brainstorm, planejamento "
        "leve. Português brasileiro, direto. Sem tools."
    ),
    "cowork": (
        "Você é Nook no MODO COWORK. Foco: automação, file system, web research. "
        "Português brasileiro, direto. Use tools quando necessário."
    ),
    "browser": (
        "Você é Nook no MODO BROWSER. Você controla o Chrome do Diogo via tools "
        "browser_open, browser_click, browser_type, browser_press, browser_extract, "
        "browser_screenshot, browser_wait, browser_url, browser_hover, browser_scroll, "
        "browser_select_option, browser_upload, browser_parallel, browser_ask_user. "
        "O Chrome tem perfil persistente — logins ficam salvos. Português brasileiro, direto.\n\n"
        "ESTRATÉGIA:\n"
        "1. Antes de clicar/digitar, tire screenshot ou extract pra confirmar o estado.\n"
        "2. Use seletores robustos: prefira `text=Texto Visível` ou `[aria-label='X']` "
        "em vez de classes geradas (.css-abc123 quebra).\n"
        "3. Após cada ação, confirme com browser_url ou browser_extract.\n"
        "4. Se algo falhar, tire screenshot e descreva o que viu.\n"
        "5. Se faltar info CRÍTICA que só o usuário sabe (senha, código de 2FA, qual "
        "opção escolher entre várias, confirmação destrutiva), use browser_ask_user "
        "ANTES de tentar — vai pausar até a resposta. NÃO chute valores."
    ),
    "codigo": (
        "Você é Nook no MODO CÓDIGO. Foco: dev, refactor, debug, BMAD artefatos. "
        "Português brasileiro, direto. Antes de gerar PRD/arquitetura, consulte o "
        "hub. Após decisões, sugira salvar como ADR.\n\n"
        "CONECTAR PRODUÇÃO (Supabase): se o usuário colar um Supabase access token no "
        "chat e pedir pra conectar/configurar a produção, NÃO mande ele preencher a UI — "
        "faça você via Bash:\n"
        "  curl -s -X POST http://127.0.0.1:3000/api/code/db/connect "
        "-H 'Content-Type: application/json' "
        "-d '{\"path\":\"<cwd do projeto>\",\"token\":\"<token>\"}'\n"
        "Se a resposta tiver \"needsPick\":true, liste os projetos retornados e PERGUNTE "
        "qual é a produção; depois re-chame com \"ref\":\"<ref escolhido>\". "
        "Em \"connected\":true, avise que o Prod-Cloud foi configurado (peça pra recarregar "
        "a aba Banco). NUNCA exponha/repita o token na resposta."
    ),
}


def _sse(data: dict) -> bytes:
    return ("data: " + json.dumps(data, ensure_ascii=False) + "\n\n").encode("utf-8")


def _tool_summary(name: str, inp: dict, out: object) -> str:
    if name in ("Read", "Edit", "Write"):
        return inp.get("file_path", "") or inp.get("path", "")
    if name == "Bash":
        return (inp.get("command", "") or "")[:80]
    if name in ("Glob", "Grep"):
        return inp.get("pattern", "") or inp.get("path", "")
    if name in ("WebFetch", "WebSearch"):
        return inp.get("url", "") or inp.get("query", "")
    return ""


async def handle_chat(request: web.Request) -> web.StreamResponse:
    body = await request.json()
    prompt = body.get("prompt", "")
    messages = body.get("messages") or []
    agent = body.get("agent")
    mode = body.get("mode", "codigo")
    projeto = body.get("projeto")
    explicit_cwd = body.get("cwd")

    # If messages history was provided, the LAST user message is the active turn.
    # Earlier turns are summarized as context appended to the system prompt so Claude
    # treats the new instruction as a real ask (not roleplay continuation).
    history_context = ""
    if messages and not prompt:
        last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
        prompt = (last_user.get("content") or "") if last_user else ""
        prior = []
        for m in messages[:-1][-10:] if last_user else messages[-10:]:
            role = m.get("role", "user")
            content = m.get("content") or ""
            if not isinstance(content, str):
                content = str(content)
            prior.append(f"[{role}]: {content[:500]}")
        if prior:
            history_context = (
                "\n\nHISTÓRICO DA CONVERSA (últimas mensagens):\n" + "\n".join(prior)
                + "\n\nO browser pode já ter páginas abertas. Use browser_url ou "
                "browser_screenshot pra confirmar estado se precisar."
            )

    resp = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
    await resp.prepare(request)

    try:
        system_prompt = load_agent(agent) if agent else DEFAULT_PROMPTS.get(mode, DEFAULT_PROMPTS["codigo"])
        # Inject user profile (Kairos) when available — gives every sidecar mode access
        profile_md = read_user_profile()
        if profile_md:
            system_prompt = (
                "## Perfil cumulativo do usuário (use como base, não cite literalmente):\n\n"
                + profile_md
                + "\n\n---\n\n"
                + system_prompt
            )
        if history_context:
            system_prompt = system_prompt + history_context
        enriched = await enrich_prompt_async(prompt, agent, mode)

        cwd = None
        if explicit_cwd and Path(explicit_cwd).is_dir():
            cwd = explicit_cwd
        elif projeto:
            cand = Path.home() / "dev" / "projetos" / projeto
            if cand.exists():
                cwd = str(cand)
        elif mode == "codigo":
            cwd = str(Path.home() / "dev" / "nook")

        mcp_servers = {}
        if mode == "browser":
            mcp_servers["nook-browser"] = make_browser_mcp(MANUAL_SESSION)

        options = ClaudeAgentOptions(
            system_prompt=system_prompt,
            allowed_tools=MODE_TOOLS.get(mode, []),
            cwd=cwd,
            mcp_servers=mcp_servers if mcp_servers else None,
        )

        async for msg in query(prompt=enriched, options=options):
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, ThinkingBlock):
                        await resp.write(_sse({"kind": "thinking", "text": block.thinking}))
                    elif isinstance(block, TextBlock):
                        if block.text:
                            await resp.write(_sse({"kind": "token", "text": block.text}))
                    elif isinstance(block, ToolUseBlock):
                        await resp.write(_sse({
                            "kind": "tool",
                            "id": block.id,
                            "name": block.name,
                            "input": block.input or {},
                        }))
            elif isinstance(msg, ResultMessage):
                # Final usage
                if msg.usage:
                    await resp.write(_sse({
                        "kind": "usage",
                        "input": msg.usage.get("input_tokens", 0),
                        "output": msg.usage.get("output_tokens", 0),
                    }))
            else:
                # Tool results come embedded in user messages between assistant turns
                content = getattr(msg, "content", None)
                if content:
                    for block in content:
                        if isinstance(block, ToolResultBlock):
                            tool_text = ""
                            if isinstance(block.content, list):
                                for c in block.content:
                                    if isinstance(c, dict) and c.get("type") == "text":
                                        tool_text = c.get("text", "")[:120]
                                        break
                            elif isinstance(block.content, str):
                                tool_text = block.content[:120]
                            await resp.write(_sse({
                                "kind": "tool_result",
                                "id": block.tool_use_id,
                                "ok": not block.is_error,
                                "summary": tool_text,
                            }))
        await resp.write(_sse({"kind": "done"}))
    except Exception as e:
        traceback.print_exc()
        try:
            await resp.write(_sse({"kind": "token", "text": f"Erro core: {e}"}))
            await resp.write(_sse({"kind": "done"}))
        except Exception:
            pass
    return resp


async def handle_browser_task(request: web.Request) -> web.Response:
    """Sync wrapper para tarefas de browser. Workers/scripts hit isso em vez do /chat
    SSE. Retorna {ok, text, tools, usage} ao final do agent loop."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "JSON inválido"}, status=400)
    task = (body.get("task") or body.get("prompt") or "").strip()
    if not task:
        return web.json_response({"ok": False, "error": "task obrigatório"}, status=400)
    system = DEFAULT_PROMPTS["browser"]
    profile_md = read_user_profile()
    if profile_md:
        system = (
            "## Perfil do usuário:\n\n" + profile_md + "\n\n---\n\n" + system
        )
    options = ClaudeAgentOptions(
        system_prompt=system,
        allowed_tools=BROWSER_TOOL_NAMES,
        mcp_servers={"nook-browser": make_browser_mcp(MANUAL_SESSION)},
    )
    final_text = ""
    tools_used = []
    usage = None
    try:
        async for msg in query(prompt=task, options=options):
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, TextBlock) and block.text:
                        final_text += block.text
                    elif isinstance(block, ToolUseBlock):
                        tools_used.append({"name": block.name, "input": block.input or {}})
            elif isinstance(msg, ResultMessage) and msg.usage:
                usage = {
                    "input": msg.usage.get("input_tokens", 0),
                    "output": msg.usage.get("output_tokens", 0),
                }
        return web.json_response({"ok": True, "text": final_text, "tools": tools_used, "usage": usage})
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"ok": False, "error": str(e), "text": final_text, "tools": tools_used}, status=500)


async def handle_agents(request: web.Request) -> web.Response:
    return web.json_response({"agents": list_agents(), "summary": get_hub_summary()})


async def handle_hub_list(request: web.Request) -> web.Response:
    return web.json_response(hub.list_all())


async def handle_hub_search(request: web.Request) -> web.Response:
    q = request.query.get("q", "")
    return web.json_response({"results": hub.search_hub(q) if q else []})


def _clean_tags(raw) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, str):
        items = re.split(r"[,\s]+", raw)
    elif isinstance(raw, list):
        items = [str(x) for x in raw]
    else:
        return []
    out: list[str] = []
    for t in items:
        t = t.strip().lower().lstrip("#")
        if t and t not in out:
            out.append(t[:30])
    return out[:8]


async def handle_hub_adr(request: web.Request) -> web.Response:
    b = await request.json()
    path = hub.write_adr(
        b.get("title", "Sem título"),
        b.get("projeto", ""),
        b.get("contexto", ""),
        b.get("decisao", ""),
        b.get("consequencias", ""),
        b.get("alternativas", ""),
        tags=_clean_tags(b.get("tags")),
    )
    return web.json_response({"path": path})


async def handle_hub_snippet(request: web.Request) -> web.Response:
    b = await request.json()
    path = hub.write_snippet(
        b.get("title", "Sem título"),
        b.get("linguagem", "txt"),
        b.get("contexto", ""),
        b.get("codigo", ""),
        b.get("projeto_origem", ""),
        tags=_clean_tags(b.get("tags")),
    )
    return web.json_response({"path": path})


async def handle_hub_padrao(request: web.Request) -> web.Response:
    b = await request.json()
    path = hub.write_padrao(
        b.get("title", "Sem título"),
        b.get("categoria", ""),
        b.get("stack", ""),
        b.get("problema", ""),
        b.get("solucao", ""),
        tags=_clean_tags(b.get("tags")),
    )
    return web.json_response({"path": path})


async def handle_projetos_list(request: web.Request) -> web.Response:
    return web.json_response({"projetos": ["nook"] + hub.list_projetos()})


async def handle_bmad_artifact(request: web.Request) -> web.Response:
    body = await request.json()
    try:
        out = hub.write_bmad_artifact(
            projeto=body.get("projeto", ""),
            kind=body.get("kind", ""),
            content=body.get("content", ""),
            title=body.get("title"),
            agent=body.get("agent"),
        )
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response(out)


async def handle_macros_list(request: web.Request) -> web.Response:
    macros = hub.list_macros()
    # Compute nextRun for scheduled macros
    try:
        from croniter import croniter
        from datetime import datetime
        now = datetime.now()
        for m in macros:
            cron_expr = m.get("schedule") or ""
            if not cron_expr:
                m["nextRun"] = ""
                continue
            try:
                ci = croniter(cron_expr, now)
                nxt = ci.get_next(datetime)
                m["nextRun"] = nxt.strftime("%Y-%m-%d %H:%M")
            except Exception:
                m["nextRun"] = ""
    except Exception:
        pass
    return web.json_response({"macros": macros})


async def handle_macros_stats(request: web.Request) -> web.Response:
    macros = hub.list_macros()
    total_runs = sum(int(m.get("runs") or 0) for m in macros)
    total_fails = sum(int(m.get("fails") or 0) for m in macros)
    total_ok = total_runs - total_fails
    durations = [int(m.get("avgDurationMs") or 0) for m in macros if m.get("runs")]
    avg_dur = int(sum(durations) / len(durations)) if durations else 0
    # Top failing
    by_fail_rate = sorted(
        [m for m in macros if int(m.get("runs") or 0) > 0],
        key=lambda m: (int(m.get("fails") or 0) / int(m.get("runs") or 1)),
        reverse=True,
    )[:5]
    most_run = sorted(macros, key=lambda m: int(m.get("runs") or 0), reverse=True)[:5]
    slowest = sorted(macros, key=lambda m: int(m.get("avgDurationMs") or 0), reverse=True)[:5]
    return web.json_response({
        "global": {
            "macros": len(macros),
            "scheduled": sum(1 for m in macros if m.get("schedule")),
            "totalRuns": total_runs,
            "totalOk": total_ok,
            "totalFails": total_fails,
            "successRate": round((total_ok / total_runs) * 100, 1) if total_runs else 0,
            "avgDurationMs": avg_dur,
        },
        "topFailing": [{"slug": m["slug"], "name": m["name"], "runs": int(m["runs"]), "fails": int(m["fails"])}
                       for m in by_fail_rate if int(m["fails"]) > 0],
        "mostRun": [{"slug": m["slug"], "name": m["name"], "runs": int(m["runs"])}
                    for m in most_run if int(m["runs"]) > 0],
        "slowest": [{"slug": m["slug"], "name": m["name"], "avgDurationMs": int(m["avgDurationMs"])}
                    for m in slowest if int(m["avgDurationMs"]) > 0],
        "macros": macros,
    })


async def handle_macros_run(request: web.Request) -> web.Response:
    """POST /macros/{slug}/run with optional {params, session}.

    session: "manual" (visible browser) or "scheduled" (headless). Default scheduled.
    Returns ok/error after macro completes (sync; can take a while).
    """
    slug = request.match_info["slug"]
    macro = hub.get_macro(slug)
    if not macro:
        return web.json_response({"error": "not found"}, status=404)
    try:
        body = await request.json() if request.body_exists else {}
    except Exception:
        body = {}
    params = body.get("params") or {}
    sess_label = (body.get("session") or "scheduled").lower()
    sess = MANUAL_SESSION if sess_label == "manual" else SCHEDULED_SESSION
    # Pre-validate params
    _, missing = _inject_params(macro["procedure"], params)
    if missing:
        return web.json_response({"error": "params faltando", "missing": missing}, status=400)
    result = await _run_macro_internal(macro, session=sess, params=params, notify=False)
    return web.json_response(result)


async def handle_macros_get(request: web.Request) -> web.Response:
    slug = request.match_info["slug"]
    m = hub.get_macro(slug)
    if not m:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(m)


async def handle_macros_save(request: web.Request) -> web.Response:
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        return web.json_response({"error": "name required"}, status=400)
    saved = hub.save_macro(
        name=name,
        procedure=body.get("procedure", ""),
        user_messages=body.get("userMessages") or [],
        steps=body.get("steps") or [],
        slug=body.get("slug"),
        schedule=body.get("schedule"),
        chains=body.get("chains"),
        skip_if=body.get("skipIf"),
    )
    return web.json_response(saved)


async def handle_macros_versions_list(request: web.Request) -> web.Response:
    slug = request.match_info["slug"]
    if not hub.get_macro(slug):
        return web.json_response({"error": "macro não existe"}, status=404)
    return web.json_response({"versions": hub.list_macro_versions(slug)})


async def handle_macros_version_get(request: web.Request) -> web.Response:
    slug = request.match_info["slug"]
    vid = request.match_info["version"]
    v = hub.get_macro_version(slug, vid)
    if not v:
        return web.json_response({"error": "version não encontrada"}, status=404)
    return web.json_response(v)


async def handle_macros_version_restore(request: web.Request) -> web.Response:
    slug = request.match_info["slug"]
    vid = request.match_info["version"]
    restored = hub.restore_macro_version(slug, vid)
    if not restored:
        return web.json_response({"error": "version não encontrada"}, status=404)
    return web.json_response({"ok": True, **restored})


async def handle_macros_meta(request: web.Request) -> web.Response:
    """PATCH /macros/{slug}/meta with {chains?: [slugs], skipIf?: str}."""
    slug = request.match_info["slug"]
    existing = hub.get_macro(slug)
    if not existing:
        return web.json_response({"error": "not found"}, status=404)
    body = await request.json()
    chains = body.get("chains")
    skip_if = body.get("skipIf")
    # Validate chain targets exist (warn, don't block — user may add later)
    invalid = []
    if isinstance(chains, list):
        for c in chains:
            if not hub.get_macro(c):
                invalid.append(c)
    # Validate skipIf
    if skip_if:
        try:
            from datetime import datetime
            now = datetime.now()
            ns = {"weekday": now.weekday(), "hour": now.hour, "minute": now.minute,
                  "day": now.day, "month": now.month, "year": now.year,
                  "is_weekend": now.weekday() >= 5, "is_business_day": now.weekday() < 5,
                  "is_monday": False, "is_friday": False, "is_saturday": False, "is_sunday": False}
            eval(skip_if, {"__builtins__": {}}, ns)
        except Exception as e:
            return web.json_response({"error": f"skipIf inválido: {e}"}, status=400)
    saved = hub.save_macro(
        name=existing["name"], procedure=existing["procedure"],
        user_messages=existing.get("userMessages") or [], slug=slug,
        chains=chains, skip_if=skip_if,
    )
    out = dict(saved)
    if invalid:
        out["warnInvalidChains"] = invalid
    return web.json_response(out)


async def handle_macros_schedule(request: web.Request) -> web.Response:
    """PATCH /macros/<slug>/schedule with body {schedule: "0 9 * * 1-5"} (or empty to clear)."""
    slug = request.match_info["slug"]
    existing = hub.get_macro(slug)
    if not existing:
        return web.json_response({"error": "not found"}, status=404)
    body = await request.json()
    new_schedule = body.get("schedule", "")
    if new_schedule:
        try:
            from croniter import croniter
            croniter(new_schedule)  # validate
        except Exception as e:
            return web.json_response({"error": f"cron inválido: {e}"}, status=400)
    saved = hub.save_macro(
        name=existing["name"],
        procedure=existing["procedure"],
        user_messages=existing.get("userMessages") or [],
        slug=slug,
        schedule=new_schedule,
    )
    return web.json_response(saved)


async def handle_macros_delete(request: web.Request) -> web.Response:
    slug = request.match_info["slug"]
    ok = hub.delete_macro(slug)
    if not ok:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response({"ok": True})


async def handle_hub_git_status(request: web.Request) -> web.Response:
    import time
    hub_dir = str(Path.home() / "dev" / "_hub")
    try:
        # Last commit timestamp (unix)
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", hub_dir, "log", "-1", "--format=%ct",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            return web.json_response({
                "ok": False,
                "reason": "git error",
                "stderr": err.decode("utf-8", "ignore")[:200],
            })
        last_commit_ts = int(out.decode().strip())
        # Check if remote is ahead/behind
        await (await asyncio.create_subprocess_exec(
            "git", "-C", hub_dir, "fetch", "--quiet",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )).wait()
        proc2 = await asyncio.create_subprocess_exec(
            "git", "-C", hub_dir, "rev-list", "--left-right", "--count", "HEAD...@{u}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out2, _ = await proc2.communicate()
        ahead = behind = 0
        if proc2.returncode == 0 and out2.strip():
            parts = out2.decode().strip().split()
            if len(parts) == 2:
                ahead, behind = int(parts[0]), int(parts[1])
        # Dirty?
        proc3 = await asyncio.create_subprocess_exec(
            "git", "-C", hub_dir, "status", "--porcelain",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out3, _ = await proc3.communicate()
        dirty_count = len([l for l in out3.decode().splitlines() if l.strip()])
        age_hours = (time.time() - last_commit_ts) / 3600
        return web.json_response({
            "ok": True,
            "lastCommitUnix": last_commit_ts,
            "ageHours": round(age_hours, 1),
            "ahead": ahead,
            "behind": behind,
            "dirtyCount": dirty_count,
            "stale": age_hours > 24,
            "unpushed": ahead > 0,
        })
    except Exception as e:
        return web.json_response({"ok": False, "reason": str(e)})


async def handle_browser_status(request: web.Request) -> web.Response:
    from nook_core.browser import get_pending_question
    return web.json_response({
        "manual": MANUAL_SESSION.status(),
        "scheduled": SCHEDULED_SESSION.status(),
        "pendingQuestion": get_pending_question(),
    })


async def handle_browser_answer(request: web.Request) -> web.Response:
    from nook_core.browser import submit_answer
    body = await request.json()
    answer = body.get("answer", "")
    if not answer:
        return web.json_response({"error": "answer empty"}, status=400)
    if submit_answer(answer):
        return web.json_response({"ok": True})
    return web.json_response({"error": "no pending question"}, status=400)


async def handle_record_start(request: web.Request) -> web.Response:
    from nook_core.browser import start_recording
    out = await start_recording(MANUAL_SESSION)
    return web.json_response(out)


async def handle_record_stop(request: web.Request) -> web.Response:
    from nook_core.browser import stop_recording
    out = await stop_recording()
    return web.json_response(out)


async def handle_record_state(request: web.Request) -> web.Response:
    from nook_core.browser import get_recording_state
    return web.json_response(get_recording_state())


async def handle_browser_sync_cookies(request: web.Request) -> web.Response:
    """Copia cookies da MANUAL_SESSION (Chrome do usuário, c/ logins) pra
    SCHEDULED_SESSION (perfil headless usado pelo cron). Persistente: o perfil
    do scheduler salva os cookies em disco no close()."""
    try:
        # Garantir que MANUAL_SESSION está vivo (CDP attach ou launch próprio)
        await MANUAL_SESSION.ensure()
        if MANUAL_SESSION._ctx is None:
            return web.json_response({"ok": False, "error": "manual context não inicializado"}, status=500)
        cookies = await MANUAL_SESSION._ctx.cookies()
        if not cookies:
            return web.json_response({"ok": False, "error": "nenhum cookie no MANUAL — abra/use o browser primeiro"}, status=400)
        # Abre scheduler temporariamente, injeta, fecha pra persistir no perfil
        await SCHEDULED_SESSION.ensure()
        if SCHEDULED_SESSION._ctx is None:
            return web.json_response({"ok": False, "error": "scheduler context não inicializado"}, status=500)
        await SCHEDULED_SESSION._ctx.add_cookies(cookies)
        # Persistent context salva cookies no profile_dir ao fechar
        await SCHEDULED_SESSION.close()
        domains = sorted({c.get("domain", "?") for c in cookies})[:10]
        return web.json_response({
            "ok": True,
            "count": len(cookies),
            "domains": domains,
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


# ─── Failure viewer ──────────────────────────────────────────────────────────
def _safe_fail_id(s: str) -> bool:
    return bool(re.match(r'^[\w\-\.]+$', s)) and ".." not in s


async def handle_fails_list(request: web.Request) -> web.Response:
    from nook_core.browser import FAIL_DIR
    if not FAIL_DIR.exists():
        return web.json_response({"items": []})
    items = []
    for d in sorted(FAIL_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not d.is_dir():
            continue
        meta = {}
        try:
            meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        except Exception:
            pass
        items.append({
            "id": d.name,
            "ts": meta.get("ts"),
            "tool": meta.get("tool"),
            "url": meta.get("url"),
            "args": meta.get("args"),
            "error": (meta.get("error") or "")[:300],
            "hasScreen": (d / "screen.png").exists(),
            "hasHtml": (d / "page.html").exists(),
        })
    return web.json_response({"items": items[:50]})


async def handle_fails_screen(request: web.Request) -> web.Response:
    from nook_core.browser import FAIL_DIR
    fid = request.match_info.get("id", "")
    if not _safe_fail_id(fid):
        return web.Response(status=400, text="bad id")
    p = FAIL_DIR / fid / "screen.png"
    if not p.is_file():
        return web.Response(status=404)
    return web.FileResponse(p)


async def handle_fails_html(request: web.Request) -> web.Response:
    from nook_core.browser import FAIL_DIR
    fid = request.match_info.get("id", "")
    if not _safe_fail_id(fid):
        return web.Response(status=400, text="bad id")
    p = FAIL_DIR / fid / "page.html"
    if not p.is_file():
        return web.Response(status=404)
    return web.FileResponse(p, headers={"Content-Type": "text/html; charset=utf-8"})


async def handle_fails_delete(request: web.Request) -> web.Response:
    from nook_core.browser import FAIL_DIR
    fid = request.match_info.get("id", "")
    if not _safe_fail_id(fid):
        return web.Response(status=400, text="bad id")
    d = FAIL_DIR / fid
    if d.exists() and d.is_dir():
        for f in d.iterdir():
            try:
                f.unlink()
            except Exception:
                pass
        try:
            d.rmdir()
        except Exception:
            pass
    return web.json_response({"ok": True})


async def handle_fails_clear(request: web.Request) -> web.Response:
    from nook_core.browser import FAIL_DIR
    if not FAIL_DIR.exists():
        return web.json_response({"ok": True, "deleted": 0})
    n = 0
    for d in list(FAIL_DIR.iterdir()):
        if not d.is_dir():
            continue
        for f in d.iterdir():
            try: f.unlink()
            except Exception: pass
        try: d.rmdir(); n += 1
        except Exception: pass
    return web.json_response({"ok": True, "deleted": n})


async def handle_hub_graph(request: web.Request) -> web.Response:
    try:
        graph = hub.build_graph()
        return web.json_response(graph)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def _claude_one_shot(prompt: str, system: str = "") -> str:
    """Run a one-shot Claude query (no tools) and return joined text."""
    options = ClaudeAgentOptions(system_prompt=system or "Você é Nook. Responda em português, conciso.", allowed_tools=[])
    out = []
    async for msg in query(prompt=prompt, options=options):
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, TextBlock):
                    out.append(block.text)
    return "".join(out).strip()


async def handle_hub_suggest_tags(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        body = {}
    title = (body.get("title") or "").strip()
    content = (body.get("content") or "").strip()
    kind = (body.get("kind") or "nota").strip()
    if not (title or content):
        return web.json_response({"error": "title ou content obrigatório"}, status=400)
    prompt = (
        f"Sugira de 3 a 6 tags curtas (1-2 palavras, kebab-case, em português) "
        f"para classificar este {kind}. Saída APENAS um JSON: {{\"tags\":[\"tag-1\",\"tag-2\"]}}\n\n"
        f"TÍTULO: {title}\n\nCONTEÚDO:\n{content[:2000]}"
    )
    try:
        raw = await _claude_one_shot(prompt, system="Você é Nook. Responda APENAS com JSON válido, sem markdown, sem explicações.")
        # Strip code fences if any
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        data = json.loads(raw)
        tags = [str(t).strip().lower().replace(" ", "-") for t in data.get("tags", []) if t]
        # Clean: kebab-case, max 30 chars, max 8 tags
        clean = []
        for t in tags[:8]:
            t = re.sub(r"[^a-z0-9\-áéíóúâêôãõç]", "", t)[:30]
            if t and t not in clean:
                clean.append(t)
        return web.json_response({"ok": True, "tags": clean})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=500)


async def handle_macro_from_prompt(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        body = {}
    description = (body.get("description") or "").strip()
    if not description:
        return web.json_response({"error": "description obrigatório"}, status=400)
    sys_prompt = (
        "Você é Nook. Recebe uma descrição em português de uma rotina de browser e "
        "produz um macro estruturado. Saída APENAS JSON com o schema:\n"
        "{\n"
        '  "name": "Nome curto (3-6 palavras)",\n'
        '  "procedure": "Lista numerada de passos curtos em português, um por linha. '
        'Use seletores genéricos: text=Botão, [aria-label=...], etc. Para placeholders use {var}.",\n'
        '  "schedule": "expressão cron (5 campos) ou string vazia se não recorrente",\n'
        '  "skipIf": "expressão Python opcional (weekday, hour, is_weekend, is_business_day, etc)",\n'
        '  "params": ["lista de placeholders se houver"]\n'
        "}\n"
        "Sem markdown, sem fence."
    )
    try:
        raw = await _claude_one_shot(description, system=sys_prompt)
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        data = json.loads(raw)
        # Validate cron if provided
        sched = (data.get("schedule") or "").strip()
        if sched:
            try:
                from croniter import croniter
                croniter(sched)
            except Exception:
                data["schedule"] = ""
                data["scheduleWarning"] = "cron sugerido inválido — descartado"
        return web.json_response({"ok": True, **data})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)[:200]}, status=500)


async def handle_diagnostics(request: web.Request) -> web.Response:
    """Aggregate health of everything in one shot."""
    out: dict = {"ok": True, "checks": []}
    add = lambda **kw: out["checks"].append(kw)

    # 1. Sidecar self
    add(name="Sidecar Python", status="ok", detail=f"porta {PORT}")

    # 2. BMAD agents
    try:
        from nook_core.bmad_loader import list_agents
        agents = list_agents()
        add(name="BMAD agents", status="ok", detail=f"{len(agents)}: " + ", ".join(agents))
    except Exception as e:
        add(name="BMAD agents", status="error", detail=str(e))

    # 3. Embeddings (Ollama)
    try:
        h = await embed.health()
        add(name="Embeddings (Ollama)",
            status="ok" if h.get("ok") else "warn",
            detail=h.get("model", "?") + (" · " + str(h.get("indexed", 0)) + " docs" if h.get("indexed") is not None else ""))
    except Exception as e:
        add(name="Embeddings (Ollama)", status="error", detail=str(e))

    # 4. Hub path
    try:
        if hub.HUB.exists():
            count = sum(1 for _ in hub.HUB.glob("**/*.md"))
            add(name="Obsidian hub", status="ok", detail=str(hub.HUB) + " (" + str(count) + " notes)")
        else:
            add(name="Obsidian hub", status="error", detail=f"não existe: {hub.HUB}")
    except Exception as e:
        add(name="Obsidian hub", status="error", detail=str(e))

    # 5. Browser sessions
    try:
        from nook_core.browser import MANUAL_SESSION, SCHEDULED_SESSION, _cdp_alive
        cdp_url = MANUAL_SESSION.cdp_url
        cdp_ok = await _cdp_alive(cdp_url) if cdp_url else False
        add(name="Browser CDP",
            status="ok" if cdp_ok else "warn",
            detail=cdp_url + (" alcançável (Chrome aberto com --remote-debugging-port)" if cdp_ok else " indisponível — vai usar perfil isolado"))
        manual_state = MANUAL_SESSION.status()
        sched_state = SCHEDULED_SESSION.status()
        add(name="Browser MANUAL", status="ok" if manual_state["active"] else "warn",
            detail=("ativo · " if manual_state["active"] else "ocioso · ") + manual_state["using"])
        add(name="Browser SCHEDULED", status="ok" if sched_state["active"] else "warn",
            detail=("ativo · " if sched_state["active"] else "ocioso · ") + sched_state["using"])
    except Exception as e:
        add(name="Browser", status="error", detail=str(e))

    # 6. Voice (faster-whisper)
    try:
        from nook_core import voice
        add(name="Voice (Whisper)",
            status="ok" if voice.is_available() else "warn",
            detail="model=" + voice._MODEL_NAME + (" (loaded)" if voice._MODEL else " (lazy)") if voice.is_available() else "não instalado (faster-whisper)")
    except Exception as e:
        add(name="Voice (Whisper)", status="error", detail=str(e))

    # 7. Telegram
    try:
        from nook_core import telegram_bot
        add(name="Telegram bridge",
            status="ok" if telegram_bot.is_enabled() else "warn",
            detail="ativo" if telegram_bot.is_enabled() else "TELEGRAM_BOT_TOKEN/CHAT_ID não setados")
    except Exception as e:
        add(name="Telegram bridge", status="error", detail=str(e))

    # 8. Disk space (cache dirs)
    try:
        import shutil
        cache = Path.home() / ".cache" / "nook"
        if cache.exists():
            usage = sum(f.stat().st_size for f in cache.rglob("*") if f.is_file())
            mb = round(usage / 1024 / 1024, 1)
            add(name="Cache (~/.cache/nook)", status="ok", detail=f"{mb} MB")
        else:
            add(name="Cache (~/.cache/nook)", status="warn", detail="vazio")
        free = shutil.disk_usage("/home/diogo").free / (1024**3)
        add(name="Disco /home", status="ok" if free > 5 else "warn", detail=f"{round(free, 1)} GB livres")
    except Exception as e:
        add(name="Disco", status="error", detail=str(e))

    # 9. Scheduler
    try:
        scheduled = sum(1 for m in hub.list_macros() if m.get("schedule"))
        add(name="Scheduler", status="ok", detail=f"{scheduled} macro(s) agendado(s)")
    except Exception as e:
        add(name="Scheduler", status="error", detail=str(e))

    out["ok"] = not any(c["status"] == "error" for c in out["checks"])
    return web.json_response(out)


async def handle_inbox(request: web.Request) -> web.Response:
    """Pendências agregadas: ask_user, fails recentes, próxima execução, git status."""
    from nook_core.browser import get_pending_question, FAIL_DIR
    from datetime import datetime
    import time as _t
    out: dict = {"items": [], "counts": {}}
    # 1. Pending question (browser_ask_user)
    pq = get_pending_question()
    if pq:
        out["items"].append({
            "type": "ask_user",
            "severity": "warn",
            "title": "Browser pediu input",
            "detail": pq.get("question", "")[:200],
        })
    # 2. Recent fails (last 24h)
    cutoff = _t.time() - 86400
    fail_count = 0
    if FAIL_DIR.exists():
        for d in FAIL_DIR.iterdir():
            if not d.is_dir():
                continue
            try:
                if d.stat().st_mtime >= cutoff:
                    fail_count += 1
            except Exception:
                pass
    if fail_count:
        out["items"].append({
            "type": "fails",
            "severity": "error",
            "title": f"{fail_count} falha(s) de browser nas últimas 24h",
            "detail": "Abra Browser Worker → Falhas pra revisar",
        })
    # 3. Next scheduled
    try:
        from croniter import croniter
        now = datetime.now()
        nxt = None
        for m in hub.list_macros():
            if not m.get("schedule"):
                continue
            try:
                nrun = croniter(m["schedule"], now).get_next(datetime)
                if nxt is None or nrun < nxt[1]:
                    nxt = (m, nrun)
            except Exception:
                continue
        if nxt:
            m, t = nxt
            delta_min = int((t - now).total_seconds() / 60)
            when = "em " + (f"{delta_min}min" if delta_min < 90 else f"{delta_min // 60}h")
            out["items"].append({
                "type": "next_macro",
                "severity": "info",
                "title": f"Próximo macro: {m['name']}",
                "detail": f"{when} ({t.strftime('%H:%M')}) — {m['schedule']}",
            })
    except Exception:
        pass
    # 4. Macros que falharam na última execução
    last_failed = [m for m in hub.list_macros() if m.get("lastError")]
    if last_failed:
        out["items"].append({
            "type": "macro_last_error",
            "severity": "warn",
            "title": f"{len(last_failed)} macro(s) com erro na última execução",
            "detail": ", ".join(m["name"] for m in last_failed[:3]),
        })
    out["counts"]["total"] = len(out["items"])
    out["counts"]["error"] = sum(1 for i in out["items"] if i["severity"] == "error")
    out["counts"]["warn"] = sum(1 for i in out["items"] if i["severity"] == "warn")
    return web.json_response(out)


async def handle_embed_health(request: web.Request) -> web.Response:
    return web.json_response(await embed.health())


async def handle_embed_reindex(request: web.Request) -> web.Response:
    try:
        body = await request.json() if request.body_exists else {}
    except Exception:
        body = {}
    force = bool(body.get("force", False))
    try:
        stats = await embed.reindex(force=force)
        return web.json_response({"ok": True, **stats})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_embed_search(request: web.Request) -> web.Response:
    q = request.query.get("q", "")
    if not q:
        return web.json_response({"results": []})
    top_k = int(request.query.get("top_k") or 5)
    min_score = float(request.query.get("min_score") or 0.4)
    results = await embed.semantic_search(q, top_k=top_k, min_score=min_score)
    return web.json_response({"query": q, "results": results})


async def handle_health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "agents": list_agents()})


# ── Scheduler: runs every 60s, fires macros whose cron matches ──
_scheduler_task = None
_last_fire_minute: dict[str, str] = {}  # slug -> "YYYY-MM-DD HH:MM"


def _inject_params(procedure: str, params: dict | None) -> tuple[str, list[str]]:
    """Replace {var} placeholders with given params. Returns (rendered, missing).
    Uses a simple regex (NOT str.format) so legitimate `{` in code aren't broken."""
    if not procedure:
        return "", []
    found = sorted(set(re.findall(r"\{(\w+)\}", procedure)))
    if not found:
        return procedure, []
    params = params or {}
    missing = [k for k in found if k not in params or params.get(k) in (None, "")]
    rendered = procedure
    for k, v in params.items():
        rendered = re.sub(r"\{" + re.escape(k) + r"\}", str(v), rendered)
    return rendered, missing


def _eval_skip_if(expr: str) -> tuple[bool, str]:
    """Eval a restricted skipIf expression. Returns (should_skip, reason).

    Available names: weekday (0=Mon..6=Sun), hour, minute, day, month, year,
    is_weekend, is_business_day, is_friday, is_monday.
    """
    if not expr or not expr.strip():
        return False, ""
    from datetime import datetime
    now = datetime.now()
    ns = {
        "weekday": now.weekday(),
        "hour": now.hour,
        "minute": now.minute,
        "day": now.day,
        "month": now.month,
        "year": now.year,
        "is_weekend": now.weekday() >= 5,
        "is_business_day": now.weekday() < 5,
        "is_monday": now.weekday() == 0,
        "is_friday": now.weekday() == 4,
        "is_saturday": now.weekday() == 5,
        "is_sunday": now.weekday() == 6,
    }
    try:
        result = eval(expr, {"__builtins__": {}}, ns)  # noqa: S307 — restricted ns
        return bool(result), expr
    except Exception as e:
        print(f"[macro] skipIf eval error '{expr}': {e}", flush=True)
        return False, ""


async def _run_macro_internal(macro: dict, session=None, params: dict | None = None,
                              notify: bool = True, _visited: set | None = None) -> dict:
    """Execute a macro. Returns {ok, durationMs, error?, skipped?, chained?}.

    session: SCHEDULED_SESSION (default for cron) or MANUAL_SESSION (manual play).
    params: substituições pra {var} placeholders.
    _visited: prevents infinite chain loops.
    """
    import time as _t
    from datetime import datetime
    if session is None:
        session = SCHEDULED_SESSION
    if _visited is None:
        _visited = set()
    if macro["slug"] in _visited:
        return {"ok": False, "error": "ciclo detectado em chain", "skipped": True}
    _visited.add(macro["slug"])

    # skipIf: if expression evaluates true, skip without counting as failure
    should_skip, reason = _eval_skip_if(macro.get("skipIf") or "")
    if should_skip:
        print(f"[macro] {macro['slug']} skipped (skipIf: {reason})", flush=True)
        return {"ok": True, "skipped": True, "reason": f"skipIf: {reason}", "durationMs": 0}
    today_dt = datetime.now()
    today_str = today_dt.strftime("%A, %d de %B de %Y").lower()
    iso = today_dt.strftime("%Y-%m-%d")
    rendered, missing = _inject_params(macro["procedure"], params)
    if missing:
        msg = f"params faltando: {', '.join(missing)}"
        hub.save_macro(
            name=macro["name"], procedure=macro["procedure"],
            user_messages=macro.get("userMessages") or [], slug=macro["slug"],
            last_error=msg, last_duration_ms=0,
        )
        return {"ok": False, "error": msg, "durationMs": 0}
    prompt = f"Data atual: {today_str} ({iso}).\n\nPROCEDIMENTO A EXECUTAR:\n{rendered}"
    t0 = _t.time()
    try:
        macro_system = DEFAULT_PROMPTS["browser"] + (
            "\n\nCONTEXTO DE EXECUÇÃO: você está rodando em modo headless "
            "(perfil scheduler). O usuário NÃO está vendo a tela. Se faltar "
            "info crítica, falhe explicitamente em vez de chutar."
            if session is SCHEDULED_SESSION else
            "\n\nCONTEXTO DE EXECUÇÃO: macro disparado manualmente (browser visível)."
        )
        profile_md = read_user_profile()
        if profile_md:
            macro_system = "## Perfil do usuário:\n\n" + profile_md + "\n\n---\n\n" + macro_system
        options = ClaudeAgentOptions(
            system_prompt=macro_system,
            allowed_tools=BROWSER_TOOL_NAMES,
            mcp_servers={"nook-browser": make_browser_mcp(session)},
        )
        async for _ in query(prompt=prompt, options=options):
            pass
        dur_ms = int((_t.time() - t0) * 1000)
        hub.save_macro(
            name=macro["name"], procedure=macro["procedure"],
            user_messages=macro.get("userMessages") or [], slug=macro["slug"],
            last_run=today_dt.strftime("%Y-%m-%d %H:%M"),
            last_error="", last_duration_ms=dur_ms, run_outcome="ok",
        )
        print(f"[macro] {macro['slug']} OK ({dur_ms}ms)", flush=True)
        # Chain: run downstream macros after success
        chained: list[dict] = []
        for next_slug in (macro.get("chains") or []):
            nxt = hub.get_macro(next_slug)
            if not nxt:
                chained.append({"slug": next_slug, "ok": False, "error": "macro não encontrado"})
                continue
            print(f"[macro] {macro['slug']} → chain → {next_slug}", flush=True)
            res = await _run_macro_internal(nxt, session=session, notify=notify, _visited=_visited)
            chained.append({"slug": next_slug, **res})
        out = {"ok": True, "durationMs": dur_ms}
        if chained:
            out["chained"] = chained
        return out
    except Exception as e:
        dur_ms = int((_t.time() - t0) * 1000)
        err = str(e)[:300]
        hub.save_macro(
            name=macro["name"], procedure=macro["procedure"],
            user_messages=macro.get("userMessages") or [], slug=macro["slug"],
            last_run=today_dt.strftime("%Y-%m-%d %H:%M"),
            last_error=err, last_duration_ms=dur_ms, run_outcome="fail",
        )
        print(f"[macro] {macro['slug']} FAILED: {err}", flush=True)
        if notify:
            try:
                from nook_core.telegram_bot import notify_async
                await notify_async(f"❌ Macro `{macro['slug']}` falhou: {err}")
            except Exception:
                pass
        return {"ok": False, "error": err, "durationMs": dur_ms}


async def _scheduler_loop():
    from croniter import croniter
    from datetime import datetime
    while True:
        try:
            now = datetime.now().replace(second=0, microsecond=0)
            current_minute = now.strftime("%Y-%m-%d %H:%M")
            for m in hub.list_macros():
                cron_expr = m.get("schedule") or ""
                if not cron_expr:
                    continue
                if _last_fire_minute.get(m["slug"]) == current_minute:
                    continue
                try:
                    if croniter.match(cron_expr, now):
                        _last_fire_minute[m["slug"]] = current_minute
                        macro = hub.get_macro(m["slug"])
                        if macro:
                            print(f"[scheduler] firing {m['slug']} at {current_minute}", flush=True)
                            asyncio.create_task(_run_macro_internal(macro, session=SCHEDULED_SESSION))
                except Exception as e:
                    print(f"[scheduler] cron parse error for {m['slug']}: {e}", flush=True)
        except Exception as e:
            print(f"[scheduler] loop error: {e}", flush=True)
        # Sleep to next minute boundary (account for current second)
        sec_until_next = 60 - datetime.now().second
        await asyncio.sleep(max(1, sec_until_next))


async def _on_startup(app):
    global _scheduler_task
    _scheduler_task = asyncio.create_task(_scheduler_loop())
    print("[scheduler] started", flush=True)
    asyncio.create_task(_initial_reindex())
    try:
        from nook_core import telegram_bot
        await telegram_bot.start_poller()
    except Exception as e:
        print(f"[telegram] startup failed: {e}", flush=True)


async def _initial_reindex():
    try:
        stats = await embed.reindex()
        print(f"[embed] reindex on startup: {stats}", flush=True)
    except Exception as e:
        print(f"[embed] reindex startup failed: {e}", flush=True)
    # Periodic reindex: pick up files modified externally (Obsidian edits, git pull)
    while True:
        await asyncio.sleep(300)  # 5min
        try:
            stats = await embed.reindex()
            if stats.get("new") or stats.get("updated") or stats.get("removed"):
                print(f"[embed] periodic reindex: {stats}", flush=True)
        except Exception as e:
            print(f"[embed] periodic reindex failed: {e}", flush=True)


async def _on_cleanup(app):
    global _scheduler_task
    if _scheduler_task:
        _scheduler_task.cancel()
    try:
        from nook_core import telegram_bot
        await telegram_bot.stop_poller()
    except Exception:
        pass


async def handle_voice_status(request: web.Request) -> web.Response:
    from nook_core import voice
    return web.json_response({"available": voice.is_available(), "model": voice._MODEL_NAME})


async def handle_voice_transcribe(request: web.Request) -> web.Response:
    from nook_core import voice
    if not voice.is_available():
        return web.json_response({"ok": False, "error": "faster-whisper não instalado"}, status=503)
    # Aceita multipart com campo "audio" OU body raw
    audio = b""
    lang = "pt"
    if request.content_type and "multipart" in request.content_type:
        reader = await request.multipart()
        async for part in reader:
            if part.name == "audio":
                audio = await part.read()
            elif part.name == "language":
                lang = (await part.text()).strip() or "pt"
    else:
        audio = await request.read()
        lang = request.query.get("language", "pt")
    result = await voice.transcribe(audio, language=lang)
    return web.json_response(result, status=200 if result.get("ok") else 400)


async def handle_telegram_status(request: web.Request) -> web.Response:
    from nook_core import telegram_bot
    return web.json_response({"enabled": telegram_bot.is_enabled()})


async def handle_telegram_test(request: web.Request) -> web.Response:
    from nook_core import telegram_bot
    if not telegram_bot.is_enabled():
        return web.json_response({"ok": False, "reason": "disabled"}, status=400)
    ok = await telegram_bot.notify_async("✅ Nook: teste de notificação")
    return web.json_response({"ok": ok})


def make_app() -> web.Application:
    app = web.Application()
    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)
    app.router.add_get("/health", handle_health)
    app.router.add_get("/agents", handle_agents)
    app.router.add_post("/chat", handle_chat)
    app.router.add_post("/sdk/chat", handle_sdk_chat)
    app.router.add_post("/sdk/permission", handle_sdk_permission)
    app.router.add_post("/browser/task", handle_browser_task)
    app.router.add_get("/hub/list", handle_hub_list)
    app.router.add_get("/hub/search", handle_hub_search)
    app.router.add_post("/hub/adr", handle_hub_adr)
    app.router.add_post("/hub/snippet", handle_hub_snippet)
    app.router.add_post("/hub/padrao", handle_hub_padrao)
    app.router.add_get("/hub/git-status", handle_hub_git_status)
    app.router.add_get("/macros", handle_macros_list)
    app.router.add_get("/macros/stats", handle_macros_stats)
    app.router.add_get("/macros/{slug}", handle_macros_get)
    app.router.add_post("/macros", handle_macros_save)
    app.router.add_delete("/macros/{slug}", handle_macros_delete)
    app.router.add_patch("/macros/{slug}/schedule", handle_macros_schedule)
    app.router.add_patch("/macros/{slug}/meta", handle_macros_meta)
    app.router.add_post("/macros/{slug}/run", handle_macros_run)
    app.router.add_get("/macros/{slug}/versions", handle_macros_versions_list)
    app.router.add_get("/macros/{slug}/versions/{version}", handle_macros_version_get)
    app.router.add_post("/macros/{slug}/versions/{version}/restore", handle_macros_version_restore)
    app.router.add_get("/projetos", handle_projetos_list)
    app.router.add_post("/hub/bmad-artifact", handle_bmad_artifact)
    app.router.add_get("/browser/status", handle_browser_status)
    app.router.add_post("/browser/answer", handle_browser_answer)
    app.router.add_post("/browser/sync-cookies", handle_browser_sync_cookies)
    app.router.add_post("/browser/record/start", handle_record_start)
    app.router.add_post("/browser/record/stop", handle_record_stop)
    app.router.add_get("/browser/record/state", handle_record_state)
    app.router.add_get("/browser/fails", handle_fails_list)
    app.router.add_get("/browser/fails/{id}/screen.png", handle_fails_screen)
    app.router.add_get("/browser/fails/{id}/page.html", handle_fails_html)
    app.router.add_delete("/browser/fails/{id}", handle_fails_delete)
    app.router.add_post("/browser/fails/clear", handle_fails_clear)
    app.router.add_get("/telegram/status", handle_telegram_status)
    app.router.add_post("/telegram/test", handle_telegram_test)
    app.router.add_get("/voice/status", handle_voice_status)
    app.router.add_post("/voice/transcribe", handle_voice_transcribe)
    app.router.add_get("/hub/graph", handle_hub_graph)
    app.router.add_post("/hub/suggest-tags", handle_hub_suggest_tags)
    app.router.add_post("/macros/from-prompt", handle_macro_from_prompt)
    app.router.add_get("/inbox", handle_inbox)
    app.router.add_get("/diagnostics", handle_diagnostics)
    app.router.add_get("/embed/health", handle_embed_health)
    app.router.add_post("/embed/reindex", handle_embed_reindex)
    app.router.add_get("/embed/search", handle_embed_search)
    return app


if __name__ == "__main__":
    print(f"[nook_core] up on :{PORT}", flush=True)
    web.run_app(make_app(), host="127.0.0.1", port=PORT, print=None)
