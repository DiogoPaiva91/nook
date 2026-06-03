from jarvis_core import bmad_loader as bl


def test_list_agents():
    agents = bl.list_agents()
    assert set(agents) == {"analyst", "pm", "architect", "designer", "sm", "dev", "qa"}


def test_load_each_agent():
    for name in bl.list_agents():
        prompt = bl.load_agent(name)
        assert isinstance(prompt, str)
        assert len(prompt) > 50  # non-trivial content


def test_load_invalid_agent():
    import pytest
    with pytest.raises(ValueError) as exc:
        bl.load_agent("nope")
    assert "nope" in str(exc.value) or "inválido" in str(exc.value).lower()


def test_load_agent_returns_portuguese():
    # Existing local agents are PT-BR; smoke check for common PT words
    prompt = bl.load_agent("analyst")
    lowered = prompt.lower()
    # At least one of these should appear in any of our PT prompts
    assert any(w in lowered for w in ["você", "voce", "objetivo", "português", "portugues"])
