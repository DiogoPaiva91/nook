"""Carrega agentes BMAD locais como system prompts."""
from pathlib import Path

BMAD_PATH = Path.home() / "dev" / "jarvis" / "bmad" / "agents"

AGENTS = {
    "analyst":   "analyst.md",
    "pm":        "pm.md",
    "architect": "architect.md",
    "designer":  "designer.md",
    "sm":        "sm.md",
    "dev":       "dev.md",
    "qa":        "qa.md",
}


def load_agent(name: str) -> str:
    if name not in AGENTS:
        raise ValueError(f"Agente '{name}' inválido. Disponíveis: {list(AGENTS)}")
    f = BMAD_PATH / AGENTS[name]
    if not f.exists():
        raise FileNotFoundError(f"Não encontrado: {f}")
    return f.read_text(encoding="utf-8")


def list_agents() -> list[str]:
    return list(AGENTS.keys())
