"""Browser automation tools for the Cowork worker.

Two sessions:
- MANUAL_SESSION: headed Chrome, profile in ~/.jarvis-browser-profile/.
  Used when the user is training in the Browser Worker UI.
- SCHEDULED_SESSION: headless Chrome, separate profile in
  ~/.jarvis-scheduler-profile/. Used by the cron scheduler so macros run
  invisibly without disturbing the user's screen.

Each session keeps its own profile so logins persist independently. The user
needs to log into Gmail/etc once in each profile they intend to use.
"""
import asyncio
import base64
import json
import os
import re
import time
from pathlib import Path
from typing import Any

import aiohttp
from claude_agent_sdk import tool, create_sdk_mcp_server
from playwright.async_api import async_playwright, BrowserContext, Page

DEFAULT_TIMEOUT_MS = 15000
FAIL_DIR = Path.home() / ".cache" / "jarvis" / "browser-fails"

# If set, BrowserSession tries this CDP endpoint first. When the user's real
# Chrome is launched with --remote-debugging-port=9222, Playwright attaches
# to it and reuses ALL existing cookies/logins/extensions.
CDP_URL_DEFAULT = os.environ.get("JARVIS_CHROME_CDP_URL", "http://localhost:9222")


async def _cdp_alive(url: str) -> bool:
    """Quick TCP probe: is a Chrome with --remote-debugging-port listening?"""
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{url}/json/version", timeout=aiohttp.ClientTimeout(total=1.5)) as r:
                return r.status == 200
    except Exception:
        return False


class BrowserSession:
    """Browser session with CDP-first strategy.

    Try order on ensure():
      1. Connect to user's running Chrome via CDP (if available + try_cdp=True).
         Reuses real cookies/logins. Creates a NEW tab so user's tabs are untouched.
      2. Launch its own persistent Chrome at profile_dir (isolated profile).
    """

    def __init__(self, profile_dir: Path, headless: bool = False,
                 label: str = "manual", try_cdp: bool = True,
                 cdp_url: str | None = None) -> None:
        self.profile_dir = profile_dir
        self.headless = headless
        self.label = label
        self.try_cdp = try_cdp
        self.cdp_url = cdp_url if cdp_url is not None else CDP_URL_DEFAULT
        self._pw = None
        self._ctx: BrowserContext | None = None
        self._page: Page | None = None
        self._using_cdp = False
        self._lock = asyncio.Lock()

    async def ensure(self) -> Page:
        async with self._lock:
            if self._page is not None and not self._page.is_closed():
                return self._page
            self._pw = await async_playwright().start()

            # Try CDP first (user's real Chrome with logins)
            if self.try_cdp and self.cdp_url and await _cdp_alive(self.cdp_url):
                try:
                    browser = await self._pw.chromium.connect_over_cdp(self.cdp_url)
                    # Use the user's existing context (cookies/logins live here)
                    self._ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
                    self._ctx.set_default_timeout(DEFAULT_TIMEOUT_MS)
                    # New tab so we don't disrupt the user's active tab
                    self._page = await self._ctx.new_page()
                    self._using_cdp = True
                    return self._page
                except Exception as e:
                    print(f"[browser:{self.label}] CDP attach failed ({e}); falling back to isolated profile", flush=True)

            # Fallback: launch own Chrome with isolated profile
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            self._ctx = await self._pw.chromium.launch_persistent_context(
                user_data_dir=str(self.profile_dir),
                headless=self.headless,
                viewport={"width": 1280, "height": 800},
                args=["--no-default-browser-check", "--no-first-run"],
            )
            self._ctx.set_default_timeout(DEFAULT_TIMEOUT_MS)
            self._page = self._ctx.pages[0] if self._ctx.pages else await self._ctx.new_page()
            self._using_cdp = False
            return self._page

    async def close(self) -> None:
        async with self._lock:
            if self._ctx:
                try:
                    if self._using_cdp:
                        # Don't close the user's Chrome — just close our tab
                        if self._page and not self._page.is_closed():
                            await self._page.close()
                    else:
                        await self._ctx.close()
                except Exception:
                    pass
                self._ctx = None
            if self._pw:
                try:
                    await self._pw.stop()
                except Exception:
                    pass
                self._pw = None
            self._page = None
            self._using_cdp = False

    def status(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "profileDir": str(self.profile_dir),
            "headless": self.headless,
            "tryCdp": self.try_cdp,
            "cdpUrl": self.cdp_url,
            "using": "cdp" if self._using_cdp else ("isolated" if self._page else "idle"),
            "active": self._page is not None and not (self._page and self._page.is_closed()),
        }


# Both sessions try CDP first (= user's real Chrome with logins). If CDP not
# available, fall back to isolated profiles (headed for manual, headless for
# scheduler).
MANUAL_SESSION = BrowserSession(
    profile_dir=Path.home() / ".jarvis-browser-profile",
    headless=False,
    label="manual",
    try_cdp=True,
)
SCHEDULED_SESSION = BrowserSession(
    profile_dir=Path.home() / ".jarvis-scheduler-profile",
    headless=True,
    label="scheduled",
    try_cdp=True,
)
SESSION = MANUAL_SESSION  # backward compat for existing imports

# Pause-and-ask: holds a single asyncio.Future while the agent waits for user
# input. The HTTP endpoint /browser/answer fulfills it.
_PENDING_ANSWER: asyncio.Future | None = None
_PENDING_QUESTION: str = ""


def get_pending_question() -> dict | None:
    if _PENDING_ANSWER is not None and not _PENDING_ANSWER.done():
        return {"question": _PENDING_QUESTION}
    return None


def submit_answer(answer: str) -> bool:
    global _PENDING_ANSWER
    if _PENDING_ANSWER is None or _PENDING_ANSWER.done():
        return False
    _PENDING_ANSWER.set_result(answer)
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Recording mode: user demonstrates, we capture interactions and produce a
# procedure draft. JS is injected into every page of the active context; events
# call back into Python via Playwright's page.expose_function.
# ─────────────────────────────────────────────────────────────────────────────

_RECORDING: dict[str, Any] = {
    "active": False,
    "events": [],  # [{type, selector, text?, value?, url?, ts}]
    "session_label": None,
}

_RECORD_INIT_SCRIPT = r"""
(() => {
  if (window.__jarvisRecInstalled) return;
  window.__jarvisRecInstalled = true;

  function safe(s) { return (s || "").toString().trim().slice(0, 80); }

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.dataset && el.dataset.testid) return `[data-testid="${el.dataset.testid}"]`;
    if (el.id && !/^[a-z]+\-?\d{4,}/i.test(el.id) && !/[A-F0-9]{6,}/.test(el.id)) {
      return "#" + CSS.escape(el.id);
    }
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return `[aria-label="${aria.replace(/"/g, '\\"')}"]`;
    if (el.name) return `[name="${el.name.replace(/"/g, '\\"')}"]`;
    const role = el.getAttribute && el.getAttribute("role");
    const text = safe(el.innerText || el.textContent || el.value);
    const tag = (el.tagName || "").toLowerCase();
    if (text && /^(button|a|label|li)$/.test(tag)) {
      return `text=${text}`;
    }
    if (role && text) return `[role="${role}"]:has-text("${text.replace(/"/g, '\\"')}")`;
    // Fallback: tag + nth-of-type from a stable ancestor
    let path = [], cur = el;
    while (cur && cur.nodeType === 1 && path.length < 4) {
      let part = cur.tagName.toLowerCase();
      if (cur.className && typeof cur.className === "string") {
        const cls = cur.className.trim().split(/\s+/).filter(c => !/[A-Z0-9]{4,}|--/.test(c)).slice(0, 2).join(".");
        if (cls) part += "." + cls;
      }
      path.unshift(part);
      cur = cur.parentElement;
    }
    return path.join(" > ");
  }

  function send(evt) {
    try { window.__jarvisRec && window.__jarvisRec(JSON.stringify(evt)); } catch (e) {}
  }

  document.addEventListener("click", (e) => {
    const sel = selectorFor(e.target);
    send({
      type: "click",
      selector: sel,
      text: safe(e.target.innerText || e.target.textContent || e.target.value),
      tag: (e.target.tagName || "").toLowerCase(),
      url: location.href,
    });
  }, true);

  document.addEventListener("change", (e) => {
    if (!e.target.matches("input, textarea, select")) return;
    const sel = selectorFor(e.target);
    const isPwd = e.target.type === "password";
    send({
      type: "input",
      selector: sel,
      value: isPwd ? "<senha>" : safe(e.target.value),
      tag: (e.target.tagName || "").toLowerCase(),
      inputType: e.target.type,
      url: location.href,
    });
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const sel = selectorFor(e.target);
    send({
      type: "press",
      key: "Enter",
      selector: sel,
      url: location.href,
    });
  }, true);

  // Track navigations
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      send({ type: "navigate", url: location.href });
    }
  }, 500);

  send({ type: "ready", url: location.href });
})();
"""


async def start_recording(session: "BrowserSession") -> dict:
    """Begin recording: ensure page, expose function, inject script."""
    if _RECORDING["active"]:
        return {"ok": False, "reason": "already recording"}
    _RECORDING["events"] = []
    _RECORDING["active"] = True
    _RECORDING["session_label"] = session.label

    page = await session.ensure()
    ctx = page.context

    # Idempotent: check if function already exposed
    if not getattr(ctx, "_jarvis_rec_exposed", False):
        async def _on_event(payload: str):
            try:
                import json as _json
                evt = _json.loads(payload)
                evt["ts"] = int(__import__("time").time() * 1000)
                if _RECORDING["active"]:
                    _RECORDING["events"].append(evt)
            except Exception:
                pass
        try:
            await ctx.expose_function("__jarvisRec", _on_event)
            ctx._jarvis_rec_exposed = True  # type: ignore
        except Exception as e:
            print(f"[rec] expose_function failed: {e}", flush=True)

    # Add init script for future pages, plus inject into existing ones
    try:
        await ctx.add_init_script(_RECORD_INIT_SCRIPT)
    except Exception as e:
        print(f"[rec] add_init_script failed (already added?): {e}", flush=True)
    for p in ctx.pages:
        try:
            await p.evaluate(_RECORD_INIT_SCRIPT)
        except Exception:
            pass
    return {"ok": True, "label": session.label}


async def stop_recording() -> dict:
    """Stop recording, return collected events + a procedure draft (markdown)."""
    if not _RECORDING["active"]:
        return {"ok": False, "reason": "not recording", "events": [], "procedure": ""}
    _RECORDING["active"] = False
    events = _RECORDING["events"][:]
    procedure = _events_to_procedure(events)
    return {"ok": True, "events": events, "procedure": procedure}


def get_recording_state() -> dict:
    return {
        "active": _RECORDING["active"],
        "count": len(_RECORDING["events"]),
        "label": _RECORDING["session_label"],
    }


def _events_to_procedure(events: list[dict]) -> str:
    """Convert raw events into a numbered Portuguese procedure Claude can re-run."""
    lines: list[str] = []
    n = 1
    last_url = None
    # Skip "ready" markers and consecutive "navigate" events
    for evt in events:
        t = evt.get("type")
        if t == "ready":
            continue
        if t == "navigate":
            url = evt.get("url") or ""
            if url and url != last_url:
                lines.append(f"{n}. Navegar para `{url}`")
                last_url = url
                n += 1
            continue
        if t == "click":
            sel = evt.get("selector") or "?"
            txt = evt.get("text") or ""
            label = f' ("{txt}")' if txt and not sel.startswith("text=") else ""
            lines.append(f"{n}. Clicar em `{sel}`{label}")
            n += 1
        elif t == "input":
            sel = evt.get("selector") or "?"
            val = evt.get("value") or ""
            it = evt.get("inputType") or ""
            if it == "password":
                lines.append(f"{n}. Digitar a SENHA em `{sel}` (use browser_ask_user pra pegar)")
            else:
                lines.append(f'{n}. Digitar `{val}` em `{sel}`')
            n += 1
        elif t == "press":
            sel = evt.get("selector") or "?"
            lines.append(f"{n}. Pressionar Enter em `{sel}`")
            n += 1
    return "\n".join(lines) if lines else "(sem ações capturadas)"


def _ok(text: str, **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if extra:
        out["content"][0].update(extra)
    return out


def _err(msg: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": f"ERRO: {msg}"}], "isError": True}


# ─────────────────────────────────────────────────────────────────────────────
# Self-healing selectors: when a primary selector fails, try a few derived
# variants before giving up. Helps when the user (or recording) gave a brittle
# `text=Compose` and the real element is `[aria-label=Compose]`, etc.
# ─────────────────────────────────────────────────────────────────────────────
def _alt_selectors(selector: str) -> list[str]:
    s = selector.strip()
    alts: list[str] = []
    if s.startswith("text="):
        txt = s[5:].strip().strip('"').strip("'")
        if txt:
            esc = txt.replace('"', '\\"')
            alts.extend([
                f'role=button[name="{esc}"]',
                f'role=link[name="{esc}"]',
                f'role=tab[name="{esc}"]',
                f'role=menuitem[name="{esc}"]',
                f'[aria-label="{esc}"]',
                f'[title="{esc}"]',
                f'button:has-text("{esc}")',
                f'a:has-text("{esc}")',
                f':is(button,a,[role="button"],[role="link"]):has-text("{esc}")',
                f'text=/{re.escape(txt)}/i',
            ])
    elif s.startswith("[name="):
        m = re.match(r'\[name="?([^"\]]+)"?\]', s)
        if m:
            n = m.group(1)
            alts.extend([f"#{n}", f'[id="{n}"]'])
    elif s.startswith("#"):
        idv = s[1:]
        alts.append(f'[name="{idv}"]')
    return alts


async def _resilient_locate(page: Page, selector: str, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> str:
    """Verify primary or fall through alts; return the selector that resolved."""
    try:
        await page.wait_for_selector(selector, timeout=timeout_ms, state="visible")
        return selector
    except Exception as primary:
        for alt in _alt_selectors(selector):
            try:
                await page.wait_for_selector(alt, timeout=2500, state="visible")
                print(f"[browser] self-heal: '{selector}' → '{alt}'", flush=True)
                return alt
            except Exception:
                continue
        raise primary


async def _resilient_click(page: Page, selector: str, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> str:
    try:
        await page.click(selector, timeout=timeout_ms)
        return selector
    except Exception as primary:
        for alt in _alt_selectors(selector):
            try:
                await page.click(alt, timeout=3000)
                print(f"[browser] self-heal click: '{selector}' → '{alt}'", flush=True)
                return alt
            except Exception:
                continue
        raise primary


async def _resilient_fill(page: Page, selector: str, text: str, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> str:
    try:
        await page.fill(selector, text, timeout=timeout_ms)
        return selector
    except Exception as primary:
        for alt in _alt_selectors(selector):
            try:
                await page.fill(alt, text, timeout=3000)
                print(f"[browser] self-heal fill: '{selector}' → '{alt}'", flush=True)
                return alt
            except Exception:
                continue
        raise primary


# ─────────────────────────────────────────────────────────────────────────────
# Failure artifacts: on tool error, dump screenshot + HTML + meta to disk.
# Lets Claude (or the user) see what the page actually looked like when the
# selector failed.
# ─────────────────────────────────────────────────────────────────────────────
async def _save_failure(page: Page | None, tool_name: str, args: dict, err: Exception) -> str | None:
    try:
        ts = int(time.time() * 1000)
        d = FAIL_DIR / f"{ts}-{tool_name}"
        d.mkdir(parents=True, exist_ok=True)
        url = "?"
        if page is not None and not page.is_closed():
            try:
                url = page.url
            except Exception:
                pass
            try:
                png = await page.screenshot(full_page=False, type="png")
                (d / "screen.png").write_bytes(png)
            except Exception:
                pass
            try:
                html = await page.content()
                (d / "page.html").write_text(html[:500_000])
            except Exception:
                pass
        meta = {
            "tool": tool_name,
            "args": {k: (v if isinstance(v, (str, int, float, bool)) else str(v)) for k, v in args.items()},
            "error": str(err),
            "url": url,
            "ts": ts,
        }
        (d / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
        # Prune to most recent 50 to avoid disk creep
        try:
            entries = sorted(FAIL_DIR.iterdir(), key=lambda p: p.stat().st_mtime)
            for old in entries[:-50]:
                if old.is_dir():
                    for f in old.iterdir():
                        try: f.unlink()
                        except Exception: pass
                    try: old.rmdir()
                    except Exception: pass
        except Exception:
            pass
        return str(d)
    except Exception:
        return None


def _err_with_snapshot(msg: str, snapshot: str | None) -> dict[str, Any]:
    txt = f"ERRO: {msg}"
    if snapshot:
        txt += f"\n[snapshot: {snapshot}]"
    return {"content": [{"type": "text", "text": txt}], "isError": True}


def _make_tools(session: BrowserSession) -> list:
    """Build a fresh set of tool functions bound to a specific session."""

    @tool(
        "browser_open",
        f"Abre uma URL no Chrome controlado ({session.label}). O Chrome persiste entre chamadas (logins ficam salvos).",
        {"url": str},
    )
    async def browser_open(args: dict[str, Any]) -> dict[str, Any]:
        url = args.get("url", "")
        if not url:
            return _err("url vazia")
        if not url.startswith(("http://", "https://", "file://", "about:")):
            url = "https://" + url
        try:
            page = await session.ensure()
            await page.goto(url, wait_until="domcontentloaded")
            title = await page.title()
            return _ok(f"abriu {url} — {title}")
        except Exception as e:
            return _err(str(e))

    @tool(
        "browser_click",
        "Clica num elemento. selector: CSS/XPath/role. Ou use text= para texto visível: 'text=Entrar'. Auto-tenta variantes se falhar.",
        {"selector": str},
    )
    async def browser_click(args: dict[str, Any]) -> dict[str, Any]:
        selector = args.get("selector", "")
        if not selector:
            return _err("selector vazio")
        page = None
        try:
            page = await session.ensure()
            used = await _resilient_click(page, selector)
            note = f"clicou em {selector}" + (f" (via {used})" if used != selector else "")
            return _ok(note)
        except Exception as e:
            snap = await _save_failure(page, "browser_click", args, e)
            return _err_with_snapshot(str(e), snap)

    @tool(
        "browser_type",
        "Digita texto num campo. selector: CSS do input. Use submit=true pra dar Enter depois. Auto-tenta variantes se falhar.",
        {"selector": str, "text": str, "submit": bool},
    )
    async def browser_type(args: dict[str, Any]) -> dict[str, Any]:
        selector = args.get("selector", "")
        text = args.get("text", "")
        submit = bool(args.get("submit", False))
        if not selector:
            return _err("selector vazio")
        page = None
        try:
            page = await session.ensure()
            used = await _resilient_fill(page, selector, text)
            if submit:
                await page.press(used, "Enter")
            note = f"digitou em {selector}" + (" + Enter" if submit else "") + (f" (via {used})" if used != selector else "")
            return _ok(note)
        except Exception as e:
            snap = await _save_failure(page, "browser_type", args, e)
            return _err_with_snapshot(str(e), snap)

    @tool(
        "browser_press",
        "Pressiona uma tecla ou combinação (ex: 'Enter', 'Escape', 'Control+a').",
        {"key": str},
    )
    async def browser_press(args: dict[str, Any]) -> dict[str, Any]:
        key = args.get("key", "")
        if not key:
            return _err("key vazia")
        try:
            page = await session.ensure()
            await page.keyboard.press(key)
            return _ok(f"pressionou {key}")
        except Exception as e:
            return _err(str(e))

    @tool(
        "browser_extract",
        "Extrai texto da página. selector opcional (CSS); sem selector retorna o body inteiro (até 4000 chars).",
        {"selector": str},
    )
    async def browser_extract(args: dict[str, Any]) -> dict[str, Any]:
        selector = args.get("selector") or "body"
        try:
            page = await session.ensure()
            text = await page.locator(selector).first.inner_text()
            return _ok(text[:4000])
        except Exception as e:
            return _err(str(e))

    @tool(
        "browser_screenshot",
        "Tira screenshot da viewport e retorna como imagem base64. Use pra Claude ver a página.",
        {},
    )
    async def browser_screenshot(args: dict[str, Any]) -> dict[str, Any]:
        try:
            page = await session.ensure()
            png = await page.screenshot(full_page=False, type="png")
            b64 = base64.b64encode(png).decode("ascii")
            return {
                "content": [
                    {"type": "image", "data": b64, "mimeType": "image/png"},
                    {"type": "text", "text": f"screenshot {len(png)} bytes"},
                ]
            }
        except Exception as e:
            return _err(str(e))

    @tool(
        "browser_wait",
        "Espera por um seletor aparecer (timeout em ms, default 10000). Auto-tenta variantes.",
        {"selector": str, "timeout_ms": int},
    )
    async def browser_wait(args: dict[str, Any]) -> dict[str, Any]:
        selector = args.get("selector", "")
        timeout = int(args.get("timeout_ms") or 10000)
        if not selector:
            return _err("selector vazio")
        page = None
        try:
            page = await session.ensure()
            used = await _resilient_locate(page, selector, timeout_ms=timeout)
            return _ok(f"apareceu: {selector}" + (f" (via {used})" if used != selector else ""))
        except Exception as e:
            snap = await _save_failure(page, "browser_wait", args, e)
            return _err_with_snapshot(str(e), snap)

    @tool(
        "browser_url",
        "Retorna a URL atual e o título da página.",
        {},
    )
    async def browser_url(args: dict[str, Any]) -> dict[str, Any]:
        try:
            page = await session.ensure()
            title = await page.title()
            return _ok(f"{page.url} — {title}")
        except Exception as e:
            return _err(str(e))

    @tool(
        "browser_hover",
        "Passa o mouse sobre um elemento (revela menus suspensos, tooltips). Auto-tenta variantes.",
        {"selector": str},
    )
    async def browser_hover(args: dict[str, Any]) -> dict[str, Any]:
        selector = args.get("selector", "")
        if not selector:
            return _err("selector vazio")
        page = None
        try:
            page = await session.ensure()
            try:
                await page.hover(selector, timeout=DEFAULT_TIMEOUT_MS)
                used = selector
            except Exception:
                used = None
                for alt in _alt_selectors(selector):
                    try:
                        await page.hover(alt, timeout=2500)
                        used = alt
                        break
                    except Exception:
                        continue
                if not used:
                    raise
            return _ok(f"hover em {selector}" + (f" (via {used})" if used != selector else ""))
        except Exception as e:
            snap = await _save_failure(page, "browser_hover", args, e)
            return _err_with_snapshot(str(e), snap)

    @tool(
        "browser_scroll",
        "Scroll da página. direction='up'|'down' + pixels (default 600), OU to=selector pra rolar até elemento, OU y=N pra absoluto.",
        {"direction": str, "pixels": int, "to": str, "y": int},
    )
    async def browser_scroll(args: dict[str, Any]) -> dict[str, Any]:
        page = None
        try:
            page = await session.ensure()
            to_sel = (args.get("to") or "").strip()
            if to_sel:
                try:
                    await page.locator(to_sel).first.scroll_into_view_if_needed(timeout=DEFAULT_TIMEOUT_MS)
                    return _ok(f"rolou até {to_sel}")
                except Exception:
                    for alt in _alt_selectors(to_sel):
                        try:
                            await page.locator(alt).first.scroll_into_view_if_needed(timeout=2500)
                            return _ok(f"rolou até {to_sel} (via {alt})")
                        except Exception:
                            continue
                    raise
            y = args.get("y")
            if y is not None:
                await page.evaluate(f"window.scrollTo(0, {int(y)})")
                return _ok(f"scrollTo y={int(y)}")
            direction = (args.get("direction") or "down").lower()
            pixels = int(args.get("pixels") or 600)
            dy = pixels if direction == "down" else -pixels
            await page.evaluate(f"window.scrollBy(0, {dy})")
            return _ok(f"rolou {direction} {pixels}px")
        except Exception as e:
            snap = await _save_failure(page, "browser_scroll", args, e)
            return _err_with_snapshot(str(e), snap)

    @tool(
        "browser_select_option",
        "Seleciona opção em <select>. Use value, label ou index. Ex: {selector:'#estado', label:'São Paulo'}.",
        {"selector": str, "value": str, "label": str, "index": int},
    )
    async def browser_select_option(args: dict[str, Any]) -> dict[str, Any]:
        selector = args.get("selector", "")
        if not selector:
            return _err("selector vazio")
        opt: dict[str, Any] = {}
        if args.get("value"): opt["value"] = args["value"]
        if args.get("label"): opt["label"] = args["label"]
        if args.get("index") is not None: opt["index"] = int(args["index"])
        if not opt:
            return _err("informe value, label ou index")
        page = None
        try:
            page = await session.ensure()
            try:
                await page.select_option(selector, **opt)
                used = selector
            except Exception:
                used = None
                for alt in _alt_selectors(selector):
                    try:
                        await page.select_option(alt, **opt)
                        used = alt
                        break
                    except Exception:
                        continue
                if not used:
                    raise
            return _ok(f"selecionou {opt} em {selector}" + (f" (via {used})" if used != selector else ""))
        except Exception as e:
            snap = await _save_failure(page, "browser_select_option", args, e)
            return _err_with_snapshot(str(e), snap)

    @tool(
        "browser_upload",
        "Faz upload de arquivo num <input type=file>. selector: CSS do input. path: caminho absoluto do arquivo.",
        {"selector": str, "path": str},
    )
    async def browser_upload(args: dict[str, Any]) -> dict[str, Any]:
        selector = args.get("selector", "")
        path = args.get("path", "")
        if not selector or not path:
            return _err("selector e path obrigatórios")
        if not os.path.isfile(path):
            return _err(f"arquivo não encontrado: {path}")
        page = None
        try:
            page = await session.ensure()
            await page.set_input_files(selector, path)
            return _ok(f"upload {os.path.basename(path)} em {selector}")
        except Exception as e:
            snap = await _save_failure(page, "browser_upload", args, e)
            return _err_with_snapshot(str(e), snap)

    @tool(
        "browser_parallel",
        "Abre N abas em paralelo, navega cada uma e (opcional) extrai texto. tasks: [{name, url, extract?}]. Retorna lista [{name, url, title, text?}]. Concorrência máx 5.",
        {"tasks": list},
    )
    async def browser_parallel(args: dict[str, Any]) -> dict[str, Any]:
        tasks = args.get("tasks") or []
        if not isinstance(tasks, list) or not tasks:
            return _err("tasks deve ser lista não-vazia de {name, url, extract?}")
        valid = []
        for t in tasks:
            if not isinstance(t, dict): continue
            url = t.get("url", "")
            if not url: continue
            if not url.startswith(("http://", "https://", "file://", "about:")):
                url = "https://" + url
            valid.append({"name": t.get("name") or url, "url": url, "extract": t.get("extract")})
        if not valid:
            return _err("nenhuma task válida (precisa url)")
        try:
            await session.ensure()
            ctx = session._ctx  # noqa: SLF001
            if ctx is None:
                return _err("contexto do browser não inicializado")
        except Exception as e:
            return _err(str(e))

        sem = asyncio.Semaphore(5)
        results: list[dict] = []

        async def _one(task: dict) -> None:
            async with sem:
                pg = None
                row: dict[str, Any] = {"name": task["name"], "url": task["url"]}
                try:
                    pg = await ctx.new_page()
                    await pg.goto(task["url"], wait_until="domcontentloaded", timeout=20000)
                    row["title"] = await pg.title()
                    if task.get("extract"):
                        try:
                            txt = await pg.locator(task["extract"]).first.inner_text(timeout=5000)
                            row["text"] = txt[:2000]
                        except Exception as ex:
                            row["extractError"] = str(ex)[:200]
                except Exception as e:
                    row["error"] = str(e)[:300]
                finally:
                    if pg:
                        try: await pg.close()
                        except Exception: pass
                results.append(row)

        await asyncio.gather(*[_one(t) for t in valid])
        # Stable order matching input
        order = {t["name"]: i for i, t in enumerate(valid)}
        results.sort(key=lambda r: order.get(r["name"], 999))
        ok_count = sum(1 for r in results if "error" not in r)
        summary = f"{ok_count}/{len(results)} OK\n" + json.dumps(results, ensure_ascii=False, indent=2)
        return _ok(summary[:6000])

    @tool(
        "browser_ask_user",
        "PAUSA e pergunta ao usuário. Use quando faltar info crítica que só o usuário sabe (senha, código de 2FA, qual opção escolher, confirmação). Bloqueia até resposta. Timeout 10min.",
        {"question": str},
    )
    async def browser_ask_user(args: dict[str, Any]) -> dict[str, Any]:
        global _PENDING_ANSWER, _PENDING_QUESTION
        question = (args.get("question") or "").strip()
        if not question:
            return _err("question vazia")
        if _PENDING_ANSWER is not None and not _PENDING_ANSWER.done():
            return _err("já tem uma pergunta pendente — aguarde resposta")
        _PENDING_ANSWER = asyncio.get_running_loop().create_future()
        _PENDING_QUESTION = question
        # Mirror to Telegram if enabled — user can answer from phone
        try:
            from jarvis_core.telegram_bot import notify_async, is_enabled
            if is_enabled():
                asyncio.create_task(notify_async(f"❓ Jarvis pergunta: {question}\n_Responda esta mensagem._"))
        except Exception:
            pass
        try:
            answer = await asyncio.wait_for(_PENDING_ANSWER, timeout=600)
            return _ok(f"Resposta do usuário: {answer}")
        except asyncio.TimeoutError:
            return _err("timeout: usuário não respondeu em 10 minutos")
        finally:
            _PENDING_ANSWER = None
            _PENDING_QUESTION = ""

    return [
        browser_open, browser_click, browser_type, browser_press,
        browser_extract, browser_screenshot, browser_wait, browser_url,
        browser_hover, browser_scroll, browser_select_option, browser_upload,
        browser_parallel, browser_ask_user,
    ]


def make_browser_mcp(session: BrowserSession | None = None):
    """Create an MCP server bound to a specific browser session.

    Defaults to MANUAL_SESSION (headed). Pass SCHEDULED_SESSION (headless)
    for cron-triggered macros.
    """
    if session is None:
        session = MANUAL_SESSION
    return create_sdk_mcp_server(
        name="jarvis-browser",
        version="1.0.0",
        tools=_make_tools(session),
    )


BROWSER_TOOL_NAMES = [
    "mcp__jarvis-browser__browser_open",
    "mcp__jarvis-browser__browser_click",
    "mcp__jarvis-browser__browser_type",
    "mcp__jarvis-browser__browser_press",
    "mcp__jarvis-browser__browser_extract",
    "mcp__jarvis-browser__browser_screenshot",
    "mcp__jarvis-browser__browser_wait",
    "mcp__jarvis-browser__browser_url",
    "mcp__jarvis-browser__browser_hover",
    "mcp__jarvis-browser__browser_scroll",
    "mcp__jarvis-browser__browser_select_option",
    "mcp__jarvis-browser__browser_upload",
    "mcp__jarvis-browser__browser_parallel",
    "mcp__jarvis-browser__browser_ask_user",
]
