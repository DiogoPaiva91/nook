"""Telegram bridge — opt-in via env vars.

Activates only when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set. Two roles:

1. Outbound notifications: macro failures, ask_user prompts → mensagem no celular.
2. Inbound replies: poll getUpdates; if user replies and a question is pending
   (browser_ask_user), feed the reply to submit_answer().

Setup:
  1. Talk to @BotFather → /newbot → guarda o token
  2. Send any message to your bot, then visit
     https://api.telegram.org/bot<TOKEN>/getUpdates → pega o `chat.id`
  3. Export TELEGRAM_BOT_TOKEN=... e TELEGRAM_CHAT_ID=... no ambiente do sidecar

Set TELEGRAM_DISABLED=1 to force-disable even with vars set.
"""
import asyncio
import os
from typing import Optional

import aiohttp


def _config() -> tuple[str, str] | None:
    if os.environ.get("TELEGRAM_DISABLED"):
        return None
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat:
        return None
    return token, chat


def is_enabled() -> bool:
    return _config() is not None


async def notify_async(text: str, photo_path: str | None = None) -> bool:
    cfg = _config()
    if not cfg:
        return False
    token, chat = cfg
    base = f"https://api.telegram.org/bot{token}"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
            if photo_path and os.path.isfile(photo_path):
                form = aiohttp.FormData()
                form.add_field("chat_id", chat)
                form.add_field("caption", text[:1000])
                with open(photo_path, "rb") as fh:
                    form.add_field("photo", fh, filename=os.path.basename(photo_path), content_type="image/png")
                    async with s.post(f"{base}/sendPhoto", data=form) as r:
                        return r.status == 200
            async with s.post(f"{base}/sendMessage", json={
                "chat_id": chat,
                "text": text[:4000],
                "parse_mode": "Markdown",
            }) as r:
                return r.status == 200
    except Exception as e:
        print(f"[telegram] notify failed: {e}", flush=True)
        return False


# ─── Inbound polling (resolves browser_ask_user from phone) ──────────────────
_POLL_TASK: Optional[asyncio.Task] = None
_LAST_UPDATE_ID: int = 0


async def _poll_loop() -> None:
    cfg = _config()
    if not cfg:
        return
    token, chat = cfg
    base = f"https://api.telegram.org/bot{token}"
    global _LAST_UPDATE_ID
    print("[telegram] inbound poller started", flush=True)
    while True:
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=35)) as s:
                params = {"timeout": 25, "allowed_updates": ["message"]}
                if _LAST_UPDATE_ID:
                    params["offset"] = _LAST_UPDATE_ID + 1
                async with s.get(f"{base}/getUpdates", params=params) as r:
                    if r.status != 200:
                        await asyncio.sleep(5)
                        continue
                    data = await r.json()
            for upd in data.get("result", []):
                _LAST_UPDATE_ID = max(_LAST_UPDATE_ID, upd.get("update_id", 0))
                msg = upd.get("message") or {}
                if str(msg.get("chat", {}).get("id")) != chat:
                    continue
                text = (msg.get("text") or "").strip()
                if not text:
                    continue
                # Try to resolve a pending browser_ask_user
                from jarvis_core.browser import get_pending_question, submit_answer
                pending = get_pending_question()
                if pending and submit_answer(text):
                    await notify_async(f"✅ Recebido: _{text[:120]}_")
                else:
                    await notify_async("ℹ Nenhuma pergunta pendente. Use o app web pra disparar comandos.")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[telegram] poll error: {e}", flush=True)
            await asyncio.sleep(5)


async def start_poller() -> None:
    global _POLL_TASK
    if not is_enabled():
        print("[telegram] disabled (sem TELEGRAM_BOT_TOKEN/CHAT_ID)", flush=True)
        return
    if _POLL_TASK and not _POLL_TASK.done():
        return
    _POLL_TASK = asyncio.create_task(_poll_loop())


async def stop_poller() -> None:
    global _POLL_TASK
    if _POLL_TASK and not _POLL_TASK.done():
        _POLL_TASK.cancel()
        try:
            await _POLL_TASK
        except Exception:
            pass
        _POLL_TASK = None
