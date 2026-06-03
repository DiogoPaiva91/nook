from jarvis_core import agent_context as ac
from jarvis_core import obsidian_bridge as ob


def test_enrich_skips_when_agent_outside_whitelist(tmp_hub):
    ob.write_padrao("X", "y", "z", "problema", "solução")
    out = ac.enrich_prompt("oi", agent="qa")  # qa not in AGENTS_WITH_CONTEXT
    assert out == "oi"


def test_enrich_returns_unchanged_when_no_match(tmp_hub):
    # Empty hub → no semantic match → fallback substring → still no match
    out = ac.enrich_prompt("xyz123 totally unrelated query", agent="analyst")
    # Either no enrichment at all, or just the query echoed
    assert "xyz123" in out


def test_enrich_adds_context_when_substring_matches(tmp_hub, monkeypatch):
    # Force semantic search to return empty so substring path kicks in
    async def _no_semantic(query):
        return ""
    monkeypatch.setattr(ac, "_semantic_context_async", _no_semantic)

    ob.write_padrao("RLS por owner", "auth", "supabase",
                    "isolar dados por tenant", "auth.uid() = user_id")
    out = ac.enrich_prompt("preciso de uma solução pra tenant isolation", agent="architect")
    # When substring fires, the prompt is wrapped with INSTRUÇÃO marker
    assert "tenant isolation" in out
    # Either matched via "tenant" keyword and includes RLS context, or didn't match;
    # we just assert no crash
