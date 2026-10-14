"""Route-level tests for the console shell (webapp.py).

The shell's WeKnora calls are monkeypatched at the seams
(`_login_upstream`, `_mcp_rpc`), so these tests run without the live
stack and pin the contracts that matter:

  * the identity-header gate on every MCP route,
  * the login proxy's allowlist (accounts.json only, no open proxy),
  * destructive tool badges,
  * the checklist's capability gating (skip WITH reason, never a fake
    failure) and its abort path when the document failed to parse,
  * the static assets mount.
"""
import json

import pytest
from starlette.testclient import TestClient

import webapp


HEADERS = {
    "X-WeKnora-User-Token": "jwt-test",
    "X-Tenant-ID": "2",
    "X-WeKnora-Knowledge-Base-Ids": "kb-1",
}
# The KB selection is optional narrowing (absent = not narrowed), exactly
# like the MCP contract; the console sends it only once the user picked.
IDENTITY_ONLY = {
    "X-WeKnora-User-Token": "jwt-test",
    "X-Tenant-ID": "2",
}


def _sse_events(response) -> list[dict]:
    events = []
    for frame in response.text.split("\n\n"):
        for line in frame.splitlines():
            if line.startswith("data:"):
                events.append(json.loads(line[len("data:"):].strip()))
    return events


@pytest.fixture
def client(tmp_path, monkeypatch):
    accounts = tmp_path / "accounts.json"
    accounts.write_text(json.dumps({"accounts": [
        {"name": "演示", "email": "demo@example.com", "password": "pw"},
    ]}), encoding="utf-8")
    monkeypatch.setattr(webapp, "ACCOUNTS_PATH", accounts)
    return TestClient(webapp.build_app())


# --- header gate -----------------------------------------------------------

@pytest.mark.parametrize("path", ["/api/kbs", "/api/tools", "/api/endpoint",
                                  "/api/upload_status?upload_id=u",
                                  "/api/document_status?knowledge_id=k",
                                  "/api/kb_status?knowledge_base_id=kb"])
def test_mcp_routes_require_identity_headers(client, path):
    r = client.get(path)
    assert r.status_code == 400
    assert "X-WeKnora-User-Token" in r.json()["error"]


def test_discovery_works_before_any_kb_selection_exists(client, monkeypatch):
    """list_knowledge_bases IS how a selection gets discovered, so the
    identity-only request (no KB header) must pass the gate and reach MCP
    unnarrowed."""
    async def fake_call(name, arguments, headers, timeout=60):
        assert name == "list_knowledge_bases"
        assert "X-WeKnora-Knowledge-Base-Ids" not in headers
        return {"ok": True, "result": {"knowledge_bases": [{"id": "kb-1", "name": "K"}]},
                "http_status": 200}
    monkeypatch.setattr(webapp, "_call_tool", fake_call)
    r = client.get("/api/kbs", headers=IDENTITY_ONLY)
    assert r.status_code == 200
    assert r.json()["result"]["knowledge_bases"][0]["id"] == "kb-1"


# --- accounts + login ------------------------------------------------------

def test_accounts_lists_names_without_passwords(client):
    r = client.get("/api/accounts")
    assert r.status_code == 200
    accounts = r.json()["accounts"]
    assert accounts == [{"name": "演示", "email": "demo@example.com"}]
    assert "password" not in json.dumps(accounts)


def test_login_rejects_email_outside_the_allowlist(client):
    r = client.post("/api/login", json={"email": "stranger@example.com", "password": "x"})
    assert r.status_code == 403


def test_login_returns_profile_and_token_without_caching(client, monkeypatch):
    async def fake_upstream(email, password):
        assert (email, password) == ("demo@example.com", "pw")
        return {"token": "fresh-jwt", "user": {"id": "u-1", "tenant_id": 2},
                "active_tenant": {"id": 2}}
    monkeypatch.setattr(webapp, "_login_upstream", fake_upstream)

    r = client.post("/api/login", json={"email": "demo@example.com", "password": "pw"})
    assert r.status_code == 200
    body = r.json()
    assert body["token"] == "fresh-jwt"
    assert body["profile"]["user_id"] == "u-1"
    assert body["profile"]["tenant_id"] == "2"
    # The shell must not keep the token: no module state holds it.
    assert "fresh-jwt" not in json.dumps(webapp.state)


def test_login_surfaces_bad_credentials_as_401(client, monkeypatch):
    async def fake_upstream(email, password):
        raise webapp.LoginError(401, "账号或密码错误")
    monkeypatch.setattr(webapp, "_login_upstream", fake_upstream)
    r = client.post("/api/login", json={"email": "demo@example.com", "password": "wrong"})
    assert r.status_code == 401


# --- tools + generic runner ------------------------------------------------

def test_protocol_results_pass_through_the_decoder():
    """tools/list has no content/structuredContent wrapper; collapsing it to
    None silently emptied the tool catalog in the console."""
    raw = {"tools": [{"name": "search_knowledge", "inputSchema": {}}]}
    decoded = webapp._decode_tool_result(raw)
    assert decoded["is_error"] is False
    assert decoded["structured"] == raw


def test_tools_marks_destructive_entries(client, monkeypatch):
    async def fake_rpc(method, params, headers, timeout=60):
        assert method == "tools/list"
        return {"ok": True, "result": {"tools": [
            {"name": "search_knowledge", "description": "d", "inputSchema": {"type": "object"}},
            {"name": "delete_document", "description": "d", "inputSchema": {"type": "object"}},
            {"name": "upload_file", "description": "d", "inputSchema": {"type": "object"}},
        ]}}
    monkeypatch.setattr(webapp, "_mcp_rpc", fake_rpc)

    r = client.get("/api/tools", headers=HEADERS)
    assert r.status_code == 200
    tools = {t["name"]: t for t in r.json()["tools"]}
    assert tools["search_knowledge"]["destructive"] is False
    assert tools["delete_document"]["destructive"] is True
    assert tools["upload_file"]["destructive"] is True


def test_run_tool_reports_duration_and_error_code(client, monkeypatch):
    async def fake_call(name, arguments, headers, timeout=60):
        assert name == "delete_document"
        return {"ok": False, "result": {"error": {"code": "KB_OUT_OF_SCOPE"}},
                "error": "outside scope", "error_code": "KB_OUT_OF_SCOPE",
                "http_status": 200}
    monkeypatch.setattr(webapp, "_call_tool", fake_call)

    r = client.post("/api/tool", headers=HEADERS,
                    json={"name": "delete_document", "arguments": {"knowledge_id": "k"}})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert body["error_code"] == "KB_OUT_OF_SCOPE"
    assert isinstance(body["latency_ms"], int)


# --- checklist gating ------------------------------------------------------

def _kb_payload(*, wiki: bool, graph: bool):
    return {"knowledge_bases": [{
        "id": "kb-1", "name": "测试库",
        "capability_flags": {"vector": True, "keyword": True, "wiki": wiki, "graph": graph},
    }]}


def _scripted_rpc(routes):
    """routes: tool name -> (ok, result-or-error)."""
    async def fake_call(name, arguments, headers, timeout=60):
        if name not in routes:
            return {"ok": True, "result": {}, "http_status": 200}
        ok, payload = routes[name]
        if ok:
            return {"ok": True, "result": payload, "http_status": 200}
        return {"ok": False, "result": payload, "error": payload.get("error", {}).get("message"),
                "error_code": payload.get("error", {}).get("code"), "http_status": 200}
    return fake_call


def test_checklist_skips_wiki_and_graph_when_capabilities_are_off(client, monkeypatch):
    routes = {
        "list_knowledge_bases": (True, _kb_payload(wiki=False, graph=False)),
        "get_document_status": (True, {"status": {"parse_status": "completed",
                                                  "index_status": "completed"}}),
        "read_document": (True, {"document": {"title": "T"}, "truncated": False}),
        "list_documents": (True, {"total": 1}),
        "search_knowledge": (True, {"results": [{"chunk_id": "c"}]}),
        "grep_chunks": (True, {"results": []}),
        "get_knowledge_base_status": (True, {"status": {"documents": 1, "chunks": 2}}),
    }
    monkeypatch.setattr(webapp, "_call_tool", _scripted_rpc(routes))
    r = client.post("/api/checklist", headers=HEADERS,
                    json={"knowledge_base_id": "kb-1", "knowledge_id": "doc-1"})
    assert r.status_code == 200
    events = _sse_events(r)
    steps = {e["tool"]: e for e in events if e["type"] == "step"}
    assert steps["wiki_index"]["status"] == "skip"
    assert "未启用 Wiki" in steps["wiki_index"]["summary"]
    assert steps["query_knowledge_graph"]["status"] == "skip"
    assert "未启用图谱抽取" in steps["query_knowledge_graph"]["summary"]
    assert steps["read_document"]["status"] == "pass"
    done = [e for e in events if e["type"] == "done"][0]
    assert done["summary"]["fail"] == 0


def test_checklist_reports_graph_config_state_as_skip_not_failure(client, monkeypatch):
    routes = {
        "list_knowledge_bases": (True, _kb_payload(wiki=False, graph=True)),
        "get_document_status": (True, {"status": {"parse_status": "completed"}}),
        "get_knowledge_base_status": (True, {"status": {"documents": 1, "chunks": 1,
                                                        "graph": {"available": "available"}}}),
        "query_knowledge_graph": (False, {"error": {"code": "GRAPH_EXTRACTION_NOT_CONFIGURED",
                                                    "message": "no extract config"}}),
    }
    monkeypatch.setattr(webapp, "_call_tool", _scripted_rpc(routes))
    r = client.post("/api/checklist", headers=HEADERS,
                    json={"knowledge_base_id": "kb-1", "knowledge_id": "doc-1"})
    steps = {e["tool"]: e for e in _sse_events(r) if e["type"] == "step"}
    assert steps["query_knowledge_graph"]["status"] == "skip"
    assert "GRAPH_EXTRACTION_NOT_CONFIGURED" in steps["query_knowledge_graph"]["summary"]


def test_checklist_aborts_read_steps_when_parse_failed(client, monkeypatch):
    routes = {
        "list_knowledge_bases": (True, _kb_payload(wiki=False, graph=False)),
        "get_document_status": (True, {"status": {"parse_status": "failed",
                                                  "error_message": "boom"}}),
    }
    monkeypatch.setattr(webapp, "_call_tool", _scripted_rpc(routes))
    r = client.post("/api/checklist", headers=HEADERS,
                    json={"knowledge_base_id": "kb-1", "knowledge_id": "doc-1"})
    steps = {e["tool"]: e for e in _sse_events(r) if e["type"] == "step"}
    assert steps["get_document_status"]["status"] == "fail"
    assert steps["read_document"]["status"] == "skip"
    assert "解析未完成" in steps["read_document"]["summary"]


# --- static assets ---------------------------------------------------------

def test_assets_are_served(client):
    r = client.get("/assets/styles.css")
    assert r.status_code == 200
    assert "--green" in r.text


def test_index_serves_the_console_shell(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "MCP 验证控制台" in r.text