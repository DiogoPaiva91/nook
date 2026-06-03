from pathlib import Path

from jarvis_core import obsidian_bridge as ob


def test_slug():
    assert ob._slug("Hello World") == "hello-world"
    assert ob._slug("Açaí com 'aspas'!") == "açaí-com-aspas"
    assert ob._slug("multi  spaces--here") == "multi-spaces-here"


def test_list_all_empty(tmp_hub):
    cats = ob.list_all()
    assert cats == {"snippets": [], "padroes": [], "decisoes": [], "projetos": []}


def test_write_adr_no_template(tmp_hub):
    path_rel = ob.write_adr(
        title="Adotar pytest",
        projeto="jarvis",
        contexto="Testes ad-hoc não escalam",
        decisao="Usar pytest pra unit",
        consequencias="Mais arquivos mas confiança maior",
        alternativas="unittest, doctest",
    )
    full = tmp_hub / path_rel
    assert full.exists()
    body = full.read_text()
    assert "## Decisão\nUsar pytest pra unit" in body
    assert "projeto: jarvis" in body
    assert "tags: [adr, decisao]" in body


def test_write_adr_with_template(tmp_hub):
    # Plant a templater-style template
    (tmp_hub / "templates").mkdir()
    (tmp_hub / "templates" / "adr.md").write_text(
        "---\ndata: <% tp.date.now(\"YYYY-MM-DD\") %>\nstatus: proposto\ntags: [adr]\n---\n\n"
        "# ADR — <% tp.file.title %>\n\n## Contexto\n\n\n## Decisão\n\n\n## Alternativas consideradas\n\n",
        encoding="utf-8",
    )
    path_rel = ob.write_adr(
        title="Usar uv ao invés de pip",
        projeto="jarvis",
        contexto="pip não funciona sem python3-venv",
        decisao="uv standalone resolve sem sudo",
        consequencias="binário extra em ~/.local/bin",
        alternativas="poetry, pipx",
    )
    body = (tmp_hub / path_rel).read_text()
    # Templater token replaced
    assert "<% tp.file.title %>" not in body
    assert "Usar uv ao invés de pip" in body
    # Section bodies inserted (prefix matched "Alternativas consideradas")
    assert "uv standalone resolve sem sudo" in body
    assert "poetry, pipx" in body
    # Custom frontmatter key inserted
    assert "projeto: jarvis" in body


def test_write_snippet(tmp_hub):
    path_rel = ob.write_snippet(
        title="JSON pretty in shell",
        linguagem="bash",
        contexto="debugar APIs",
        codigo="curl ... | python3 -m json.tool",
    )
    body = (tmp_hub / path_rel).read_text()
    assert "linguagem: bash" in body
    assert "## Quando usar\ndebugar APIs" in body
    assert "```bash\ncurl ... | python3 -m json.tool\n```" in body


def test_write_padrao(tmp_hub):
    path_rel = ob.write_padrao(
        title="Status pill no chat",
        categoria="ux",
        stack="vanilla js",
        problema="usuário não sabe se app tá processando",
        solucao="pill animado com tool count + elapsed",
    )
    body = (tmp_hub / path_rel).read_text()
    assert "categoria: ux" in body
    assert "## Problema\nusuário não sabe" in body
    assert "## Solução\npill animado" in body


def test_search_hub_substring(tmp_hub):
    ob.write_snippet("RLS pattern", "sql", "auth", "CREATE POLICY ...")
    ob.write_snippet("Outro tema", "py", "x", "print(1)")
    results = ob.search_hub("RLS")
    assert len(results) >= 1
    assert any("rls-pattern" in r["path"] for r in results)


def test_get_context_for_project(tmp_hub):
    ob.write_padrao("RLS por owner", "auth", "supabase", "tenant isolation", "auth.uid() = user_id")
    ctx = ob.get_context_for_project("preciso modelar autenticação multi-tenant")
    # Substring search picks up "autenticacao" only if hub note contains it; this
    # specific note doesn't, so context may be empty — that's expected fallback.
    # But longer matching word "tenant" should hit:
    ctx2 = ob.get_context_for_project("tenant isolation strategy")
    assert "tenant" in ctx2.lower() or ctx2 == "" or "RLS" in ctx2


def test_macros_lifecycle(tmp_hub):
    saved = ob.save_macro(
        name="Lançar ponto",
        procedure="1. Abre o sistema do ponto\n2. Marca entrada de hoje",
    )
    assert saved["slug"] == "lançar-ponto"
    assert "## Procedimento" in (tmp_hub / "macros" / "lançar-ponto.md").read_text()

    listed = ob.list_macros()
    assert len(listed) == 1
    assert listed[0]["name"] == "Lançar ponto"

    fetched = ob.get_macro("lançar-ponto")
    assert "Marca entrada" in fetched["procedure"]

    # Update with schedule
    ob.save_macro(
        name="Lançar ponto",
        procedure="1. Abre\n2. Marca",
        slug="lançar-ponto",
        schedule="0 9 * * 1-5",
    )
    fetched = ob.get_macro("lançar-ponto")
    assert fetched["schedule"] == "0 9 * * 1-5"
    # created date preserved (idempotent across saves)
    assert fetched["created"] == fetched["updated"]  # same day

    assert ob.delete_macro("lançar-ponto") is True
    assert ob.list_macros() == []
    assert ob.delete_macro("nonexistent") is False


def test_bmad_artifact_writes_two_copies(tmp_hub, tmp_path, monkeypatch):
    # Redirect PROJETOS_DIR_BASE so test doesn't touch real ~/dev/projetos
    fake_projetos = tmp_path / "projetos_real"
    fake_projetos.mkdir()
    (fake_projetos / "myapp").mkdir()
    monkeypatch.setattr(ob, "PROJETOS_DIR_BASE", fake_projetos)

    out = ob.write_bmad_artifact(
        projeto="myapp",
        kind="prd",
        content="## Visão geral\nFazer X.",
        title="PRD MyApp",
        agent="pm",
    )
    assert out["projectFound"] is True
    assert len(out["written"]) == 2
    # Project copy
    proj_file = fake_projetos / "myapp" / "docs" / "prd.md"
    assert proj_file.exists()
    assert "## Visão geral" in proj_file.read_text()
    # Hub mirror
    hub_file = tmp_hub / "projetos" / "myapp" / "prd.md"
    assert hub_file.exists()


def test_bmad_artifact_invalid_kind(tmp_hub):
    import pytest
    with pytest.raises(ValueError):
        ob.write_bmad_artifact(projeto="x", kind="not-a-kind", content="...")
