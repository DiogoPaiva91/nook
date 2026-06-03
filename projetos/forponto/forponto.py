import os
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

LOGIN_URL = "https://forpontoweb.rumolog.com/ForpontoWeb/Login.aspx"
USER = os.getenv("FORPONTO_USER")
PASS = os.getenv("FORPONTO_PASS")
HEADLESS = os.getenv("FORPONTO_HEADLESS", "true").lower() == "true"
DRY_RUN = os.getenv("FORPONTO_DRY_RUN", "false").lower() == "true"

if not USER or not PASS:
    sys.exit("Configure FORPONTO_USER e FORPONTO_PASS em projetos/forponto/.env")


def login(page):
    page.goto(LOGIN_URL, wait_until="networkidle")

    # ASPX usa IDs longos (ctl00_...). Tentamos por label/placeholder primeiro,
    # caindo para seletores genéricos se necessário.
    user_field = page.locator(
        "input[name*='Usuario'], input[id*='Usuario'], input[type='text']"
    ).first
    pass_field = page.locator("input[type='password']").first
    submit = page.locator(
        "input[type='submit'], button[type='submit'], input[value*='Entrar' i]"
    ).first

    user_field.fill(USER)
    pass_field.fill(PASS)
    submit.click()
    page.wait_for_load_state("networkidle")


def registrar_ponto(page):
    candidatos = [
        "input[value*='Registrar' i]",
        "button:has-text('Registrar Ponto')",
        "a:has-text('Registrar Ponto')",
        "button:has-text('Bater Ponto')",
        "input[value*='Bater' i]",
    ]
    for sel in candidatos:
        loc = page.locator(sel).first
        if loc.count() > 0 and loc.is_visible():
            if DRY_RUN:
                print(f"[DRY_RUN] Encontrado botão: {sel} — não cliquei.")
                return
            loc.click()
            page.wait_for_load_state("networkidle")
            return
    raise RuntimeError(
        "Não achei o botão de registrar ponto. Rode com FORPONTO_HEADLESS=false "
        "e FORPONTO_DRY_RUN=true para inspecionar a página."
    )


def main():
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    shot_path = BASE_DIR / f"registros/{stamp}.png"
    shot_path.parent.mkdir(exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        ctx = browser.new_context()
        page = ctx.new_page()
        try:
            login(page)
            registrar_ponto(page)
            page.screenshot(path=str(shot_path), full_page=True)
            print(f"OK {stamp} — screenshot: {shot_path}")
        except Exception as e:
            err_path = BASE_DIR / f"registros/{stamp}_ERRO.png"
            try:
                page.screenshot(path=str(err_path), full_page=True)
            except Exception:
                pass
            print(f"FALHA {stamp}: {e}", file=sys.stderr)
            sys.exit(1)
        finally:
            ctx.close()
            browser.close()


if __name__ == "__main__":
    main()
