"""Shared fixtures: replace HUB with a tmp_path so tests don't touch the real vault."""
import sys
from pathlib import Path

import pytest

# Ensure the project root is importable
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture
def tmp_hub(tmp_path, monkeypatch):
    """Redirect obsidian_bridge.HUB and related paths to a tmp dir."""
    from jarvis_core import obsidian_bridge as ob
    monkeypatch.setattr(ob, "HUB", tmp_path)
    monkeypatch.setattr(ob, "MACROS_DIR", tmp_path / "macros")
    monkeypatch.setattr(ob, "HUB_PROJETOS_DIR", tmp_path / "projetos")
    return tmp_path
