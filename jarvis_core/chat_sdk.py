"""Chat interativo via Agent SDK: permissão real (can_use_tool) + AskUserQuestion.

/sdk/chat streama eventos SSE (mesmos `kind` do handle_chat) e, quando o agente
quer usar uma tool fora do allowlist, emite `permission_request` e BLOQUEIA num
asyncio.Future. /sdk/permission resolve o Future (allow/deny/answers).
Espelha o padrão pause-and-answer do browser_ask_user.
"""
import asyncio
import json
import traceback
from pathlib import Path

from aiohttp import web

from claude_agent_sdk import (
    query,
    ClaudeAgentOptions,
    HookMatcher,
    AssistantMessage,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
    ResultMessage,
)

# Tools auto-aprovadas sem perguntar (espelha SAFE_TOOLS do front).
AUTO_OK = {
    "Read", "Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch",
    "TaskGet", "TaskList", "NotebookRead", "TodoWrite",
}

# perm_id -> asyncio.Future. A decisão do usuário chega via /sdk/permission.
_PENDING: dict[str, asyncio.Future] = {}
_seq = 0


def _next_perm_id(session_id: str) -> str:
    global _seq
    _seq += 1
    return f"{session_id}:{_seq}"


def submit_permission(perm_id: str, decision: dict) -> bool:
    fut = _PENDING.get(perm_id)
    if fut is None or fut.done():
        return False
    fut.set_result(decision)
    return True


def _sse(data: dict) -> bytes:
    return ("data: " + json.dumps(data, ensure_ascii=False) + "\n\n").encode("utf-8")


def _tool_result_text(block: ToolResultBlock) -> tuple[bool, str]:
    text = ""
    if isinstance(block.content, list):
        for c in block.content:
            if isinstance(c, dict) and c.get("type") == "text":
                text = (c.get("text") or "")[:120]
                break
    elif isinstance(block.content, str):
        text = block.content[:120]
    return (not block.is_error), text


async def handle_sdk_chat(request: web.Request) -> web.StreamResponse:
    body = await request.json()
    session_id = str(body.get("sessionId") or "sess")
    system = body.get("system") or ""
    history = body.get("history") or []
    model = body.get("model")
    effort = body.get("effort")
    cwd = body.get("cwd")
    add_dirs = body.get("addDirs") or []
    perm_mode = body.get("permissionMode") or "default"

    prompt = ""
    for m in history:
        role = m.get("role")
        content = m.get("content") or ""
        if not isinstance(content, str):
            content = str(content)
        if role == "user":
            prompt += "User: " + content + "\n"
        elif role == "assistant":
            prompt += "Assistant: " + content + "\n"
    if not prompt.strip():
        prompt = body.get("prompt") or ""

    resp = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
    await resp.prepare(request)

    # Writes podem vir do loop principal E do can_use_tool (control protocol roda
    # concorrente). Serializa pra não corromper o framing SSE.
    write_lock = asyncio.Lock()
    my_perms: list[str] = []

    async def send(data: dict) -> None:
        async with write_lock:
            try:
                await resp.write(_sse(data))
            except Exception:
                pass

    def _proceed():
        return {}

    def _block(reason):
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}

    async def pre_tool_use(hook_input, tool_use_id, context):
        # PreToolUse roda em TODA tool (determinístico, independe de permission_mode
        # ou settings). É o ponto de gating real: bloquear retorna deny de verdade.
        tool_name = hook_input.get("tool_name") or ""
        tool_input = hook_input.get("tool_input") or {}
        if tool_name in AUTO_OK:
            return _proceed()
        perm_id = _next_perm_id(session_id)
        fut = asyncio.get_running_loop().create_future()
        _PENDING[perm_id] = fut
        my_perms.append(perm_id)
        await send({
            "kind": "permission_request",
            "permId": perm_id,
            "name": tool_name,
            "input": tool_input,
        })
        try:
            decision = await asyncio.wait_for(fut, timeout=600)
        except asyncio.TimeoutError:
            decision = {"decision": "deny", "message": "Sem resposta do usuário (timeout)."}
        finally:
            _PENDING.pop(perm_id, None)
        if decision.get("decision") == "allow":
            return _proceed()
        # deny ou resposta de AskUserQuestion: a mensagem volta pro agente como motivo.
        return _block(decision.get("message") or "Negado pelo usuário.")

    opts_kwargs = dict(
        system_prompt=system or None,
        permission_mode=perm_mode,
        hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[pre_tool_use])]},
        # Não herda o allowlist do ~/.claude/settings.json — mantém o gating só no hook.
        setting_sources=[],
    )
    if model:
        opts_kwargs["model"] = model
    if cwd and Path(cwd).is_dir():
        opts_kwargs["cwd"] = cwd
    valid_dirs = [d for d in add_dirs if isinstance(d, str) and Path(d).is_dir()]
    if valid_dirs:
        opts_kwargs["add_dirs"] = valid_dirs
    if effort:
        opts_kwargs["effort"] = effort

    async def _input_stream():
        # can_use_tool exige streaming input: entrega o turno como uma mensagem só
        # (o histórico já vem concatenado em `prompt`, igual ao provider CLI).
        yield {"type": "user", "message": {"role": "user", "content": prompt}}

    try:
        options = ClaudeAgentOptions(**opts_kwargs)
        async for msg in query(prompt=_input_stream(), options=options):
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, ThinkingBlock):
                        await send({"kind": "thinking", "text": block.thinking})
                    elif isinstance(block, TextBlock):
                        if block.text:
                            await send({"kind": "token", "text": block.text})
                    elif isinstance(block, ToolUseBlock):
                        await send({
                            "kind": "tool",
                            "id": block.id,
                            "name": block.name,
                            "input": block.input or {},
                        })
            elif isinstance(msg, ResultMessage):
                usage = getattr(msg, "usage", None) or {}
                await send({
                    "kind": "usage",
                    "input": usage.get("input_tokens", 0),
                    "output": usage.get("output_tokens", 0),
                    "cacheRead": usage.get("cache_read_input_tokens", 0),
                    "cacheCreate": usage.get("cache_creation_input_tokens", 0),
                    "totalCostUsd": getattr(msg, "total_cost_usd", None),
                    "model": model or "",
                })
            else:
                content = getattr(msg, "content", None)
                if content:
                    for block in content:
                        if isinstance(block, ToolResultBlock):
                            ok, summary = _tool_result_text(block)
                            await send({
                                "kind": "tool_result",
                                "id": block.tool_use_id,
                                "ok": ok,
                                "summary": summary,
                            })
        await send({"kind": "done"})
    except Exception as e:
        traceback.print_exc()
        await send({"kind": "error", "message": f"core: {e}"})
        await send({"kind": "done"})
    finally:
        for pid in my_perms:
            _PENDING.pop(pid, None)
    return resp


async def handle_sdk_permission(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "JSON inválido"}, status=400)
    perm_id = body.get("permId")
    if not perm_id:
        return web.json_response({"error": "permId obrigatório"}, status=400)
    decision = {
        "decision": body.get("decision") or "deny",
        "message": body.get("message"),
        "updatedInput": body.get("updatedInput"),
    }
    if submit_permission(perm_id, decision):
        return web.json_response({"ok": True})
    return web.json_response({"error": "permissão não pendente (timeout ou já resolvida)"}, status=400)
