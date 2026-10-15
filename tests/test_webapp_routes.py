"""Thin MCP workbench contracts: external credentials, request identity,
MCP-only endpoint discovery, safe errors, tool status and checklist streaming."""
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
def client():
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


# --- external credentials / MCP-only metadata ------------------------------

@pytest.mark.parametrize("method,path", [("GET", "/api/accounts"),
    ("POST", "/api/login"), ("POST", "/api/relogin")])
def test_credential_routes_are_absent(client, method, path):
    assert client.request(method, path).status_code == 404


def test_info_uses_static_default_profile_without_credentials(client, monkeypatch):
    monkeypatch.setattr(webapp, "_mcp_endpoint_target", lambda: ("http://localhost:18082", "ep"))
    body = client.get("/api/info").json()
    assert body["default_email"] == "15918868657@163.com"
    assert "accounts_available" not in body


def test_endpoint_metadata_comes_only_from_mcp_tools_list(client, monkeypatch):
    monkeypatch.setattr(webapp, "_mcp_endpoint_target", lambda: ("http://localhost:18082", "ep"))
    async def rpc(method, params, headers, timeout=60):
        assert method == "tools/list"
        assert headers == HEADERS
        return {"ok": True, "result": {"tools": [{"name": "read_document"}]}}
    monkeypatch.setattr(webapp, "_mcp_rpc", rpc)
    body = client.get("/api/endpoint", headers=HEADERS).json()
    assert body["ok"] is True
    assert body["endpoint_id"] == "ep"
    assert body["tools"] == ["read_document"]


def test_browser_identity_overrides_unset_env_without_global_mutation(tmp_path, monkeypatch):
    config = tmp_path / "mcp.json"
    config.write_text(json.dumps({"weknora": {"url": "http://localhost/mcp/ep",
        "transport": "http", "headers": {"X-WeKnora-User-Token": "${WEKNORA_USER_TOKEN}",
        "X-Tenant-ID": "${WEKNORA_TENANT_ID}",
        "X-WeKnora-Knowledge-Base-Ids": "${WEKNORA_KB_IDS}"}}}))
    monkeypatch.setattr(webapp, "ROOT", tmp_path)
    for name in ("WEKNORA_USER_TOKEN", "WEKNORA_TENANT_ID", "WEKNORA_KB_IDS"):
        monkeypatch.delenv(name, raising=False)
    import os
    before = dict(os.environ)
    conn = webapp._build_connection("endpoint-secret", IDENTITY_ONLY)["weknora"]
    assert conn["headers"]["X-WeKnora-User-Token"] == "jwt-test"
    assert "X-WeKnora-Knowledge-Base-Ids" not in conn["headers"]
    assert dict(os.environ) == before


@pytest.mark.parametrize("path", ["/api/kbs", "/api/tools", "/api/endpoint"])
def test_expired_mcp_identity_returns_401(client, monkeypatch, path):
    async def fail(*args, **kwargs):
        return {"ok": False, "http_status": 401, "error": "MCP authentication failed",
                "error_code": "UNAUTHORIZED"}
    monkeypatch.setattr(webapp, "_call_tool", fail)
    monkeypatch.setattr(webapp, "_mcp_rpc", fail)
    monkeypatch.setattr(webapp, "_mcp_endpoint_target", lambda: ("http://localhost", "ep"))
    assert client.get(path, headers=HEADERS).status_code == 401


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
    assert "WeKnora" in r.text and "/assets/app.js" in r.text

@pytest.mark.asyncio
@pytest.mark.parametrize("status,body", [(401, b'jwt-test endpoint-secret password-secret'),
    (200, b'not-json jwt-test endpoint-secret'),
    (200, b'{"jsonrpc":"2.0","error":{"code":-32000,"message":"jwt-test endpoint-secret"}}')])
async def test_rpc_errors_never_echo_identity_or_upstream_body(monkeypatch, status, body):
    import io
    import urllib.error
    import urllib.request
    monkeypatch.setattr(webapp, "_mcp_endpoint_target", lambda: ("http://localhost", "ep"))
    monkeypatch.setattr(webapp, "_endpoint_token", lambda: "endpoint-secret")
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self): return body
    Response.status = status
    def urlopen(request, timeout):
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, "bad", {}, io.BytesIO(body))
        return Response()
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    result = await webapp._mcp_rpc("tools/list", {}, HEADERS)
    assert result["ok"] is False
    assert result["http_status"] == status
    assert all(secret not in json.dumps(result) for secret in ("jwt-test", "endpoint-secret", "password-secret"))
    if status == 401:
        assert result["error_code"] == "UNAUTHORIZED"


@pytest.mark.asyncio
async def test_agent_initialization_error_is_secret_free(monkeypatch, caplog):
    def fail(*args): raise ValueError("jwt-test password-secret")
    monkeypatch.setattr(webapp, "_endpoint_token", fail)
    events = [event async for event in webapp._stream_agent_chat("question", HEADERS)]
    text = json.dumps(events) + caplog.text
    assert "jwt-test" not in text
    assert "password-secret" not in text


@pytest.mark.asyncio
async def test_rpc_decodes_the_matching_sse_response_and_redacts_identity(monkeypatch):
    import urllib.request
    monkeypatch.setattr(webapp, "_mcp_endpoint_target", lambda: ("http://localhost", "ep"))
    monkeypatch.setattr(webapp, "_endpoint_token", lambda: "endpoint-secret")
    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self):
            return b': ping\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"read_document"}],"token":"jwt-test"}}\r\n\r\n'
    monkeypatch.setattr(urllib.request, "urlopen", lambda request, timeout: Response())
    result = await webapp._mcp_rpc("tools/list", {}, HEADERS)
    assert result["ok"] is True
    assert result["result"]["tools"][0]["name"] == "read_document"
    assert "jwt-test" not in json.dumps(result)


@pytest.mark.asyncio
async def test_sdk_401_is_classified_in_error_sse(monkeypatch):
    class Unauthorized(Exception):
        status_code = 401
    def fail(*args): raise ExceptionGroup("SDK request failed", [Unauthorized("jwt-test")])
    monkeypatch.setattr(webapp, "_endpoint_token", fail)
    events = [json.loads(event["data"]) async for event in webapp._stream_agent_chat("question", HEADERS)]
    error = next(event for event in events if event["type"] == "error")
    assert error["http_status"] == 401
    assert error["error_code"] == "UNAUTHORIZED"
    assert "jwt-test" not in json.dumps(events)


def test_checklist_route_classifies_initial_mcp_401_before_done(client, monkeypatch):
    calls = []
    async def unauthorized(name, arguments, headers, timeout=60):
        calls.append(name)
        return {"ok": False, "http_status": 401, "error_code": "UNAUTHORIZED",
                "error": "MCP HTTP 401"}
    monkeypatch.setattr(webapp, "_call_tool", unauthorized)
    events = _sse_events(client.post("/api/checklist", headers=HEADERS,
        json={"knowledge_base_id": "kb-1", "knowledge_id": "doc-1"}))
    failure = next(event for event in events if event["type"] == "step")
    assert failure["http_status"] == 401
    assert failure["error_code"] == "UNAUTHORIZED"
    error = next(event for event in events if event["type"] == "error")
    assert error["http_status"] == 401 and error["error_code"] == "UNAUTHORIZED"
    assert events.index(error) < next(i for i, event in enumerate(events) if event["type"] == "done")
    assert events[-1]["summary"]["fail"] == 1
    assert calls == ["list_knowledge_bases"]


@pytest.mark.asyncio
async def test_document_poll_retains_401_fields_after_processing(monkeypatch):
    replies = [{"ok": True, "result": {"status": {"parse_status": "processing"}}, "http_status": 200},
        {"ok": False, "http_status": 401, "error_code": "UNAUTHORIZED", "error": "MCP HTTP 401"}]
    async def call(*args, **kwargs): return replies.pop(0)
    monkeypatch.setattr(webapp, "_call_tool", call)
    monkeypatch.setattr(webapp, "CHECKLIST_POLL_INTERVAL", 0)
    result = await webapp._poll_document("doc-1", HEADERS)
    assert result["ok"] is False
    assert result["http_status"] == 401 and result["error_code"] == "UNAUTHORIZED"
    assert replies == []


def test_checklist_revoked_jwt_during_poll_is_an_auth_error_and_stops(client, monkeypatch):
    calls = []
    async def call(name, arguments, headers, timeout=60):
        calls.append(name)
        if name == "list_knowledge_bases":
            return {"ok": True, "result": _kb_payload(wiki=False, graph=False), "http_status": 200}
        if name == "get_document_status":
            if calls.count(name) == 1:
                return {"ok": True, "result": {"status": {"parse_status": "processing"}}, "http_status": 200}
            return {"ok": False, "http_status": 401, "error_code": "UNAUTHORIZED", "error": "MCP HTTP 401"}
        return {"ok": True, "result": {}, "http_status": 200}
    monkeypatch.setattr(webapp, "_call_tool", call)
    monkeypatch.setattr(webapp, "CHECKLIST_POLL_INTERVAL", 0)
    events = _sse_events(client.post("/api/checklist", headers=HEADERS,
        json={"knowledge_base_id": "kb-1", "knowledge_id": "doc-1"}))
    failure = next(event for event in events if event.get("tool") == "get_document_status")
    assert failure["http_status"] == 401 and failure["error_code"] == "UNAUTHORIZED"
    error = next(event for event in events if event["type"] == "error")
    assert error["http_status"] == 401 and error["error_code"] == "UNAUTHORIZED"
    assert calls == ["list_knowledge_bases", "get_document_status", "get_document_status"]
    assert events[-1]["type"] == "done" and events[-1]["summary"]["fail"] == 1


# --- local credential file (demo convenience) ------------------------------

def test_local_credential_reads_the_issued_file(client, monkeypatch, tmp_path):
    credential = tmp_path / "workbench-user-token.local.json"
    credential.write_text(json.dumps({
        "profile": {"email": "demo@example.com", "tenant_id": "2", "user_id": "u-1"},
        "token": "issued-jwt", "expires_at": "2026-10-16T05:15:45Z",
    }), encoding="utf-8")
    monkeypatch.setenv("WEKNORA_CREDENTIAL_FILE", str(credential))

    r = client.get("/api/local-credential", headers={"Host": "127.0.0.1:18100"})
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True
    assert body["credential"]["token"] == "issued-jwt"
    assert body["credential"]["profile"]["tenant_id"] == "2"
    assert body["credential"]["expires_at"] == "2026-10-16T05:15:45Z"
    # The file path never leaves the server.
    assert "source" not in body and "path" not in json.dumps(body)


def test_local_credential_missing_file_gives_the_refresh_hint(client, monkeypatch, tmp_path):
    monkeypatch.setenv("WEKNORA_CREDENTIAL_FILE", str(tmp_path / "missing.json"))
    r = client.get("/api/local-credential", headers={"Host": "127.0.0.1:18100"})
    body = r.json()
    assert r.status_code == 200
    assert body["available"] is False
    assert "refresh-credential" in body["hint"]
    assert r.headers.get("cache-control") == "no-store"


def test_local_credential_without_a_token_is_not_available(client, monkeypatch, tmp_path):
    credential = tmp_path / "empty-token.json"
    credential.write_text(json.dumps({"profile": {}, "token": ""}), encoding="utf-8")
    monkeypatch.setenv("WEKNORA_CREDENTIAL_FILE", str(credential))
    body = client.get("/api/local-credential", headers={"Host": "127.0.0.1:18100"}).json()
    assert body["available"] is False
    assert "Token" in body["hint"]


def test_local_credential_disabled_without_explicit_opt_in(client, monkeypatch):
    monkeypatch.delenv("WEKNORA_CREDENTIAL_FILE", raising=False)
    r = client.get("/api/local-credential", headers={"Host": "127.0.0.1:18100"})
    assert r.status_code == 404
    assert "WEKNORA_CREDENTIAL_FILE" in r.json()["hint"]


def test_local_credential_refuses_non_local_hosts(client, monkeypatch, tmp_path):
    credential = tmp_path / "workbench-user-token.local.json"
    credential.write_text(json.dumps({
        "profile": {"email": "demo@example.com"}, "token": "issued-jwt",
    }), encoding="utf-8")
    monkeypatch.setenv("WEKNORA_CREDENTIAL_FILE", str(credential))
    for host in ("attacker.invalid", "192.168.1.10:18100"):
        r = client.get("/api/local-credential", headers={"Host": host})
        assert r.status_code == 403, host
        assert r.json()["available"] is False


# --- parser engine catalog proxy ------------------------------------------

def test_parser_engines_proxies_the_mcp_catalog(client, monkeypatch):
    async def fake_call(name, arguments, headers, timeout=60):
        assert name == "list_parser_engines"
        return {"ok": True, "http_status": 200, "result": {
            "engines": [{"name": "builtin", "available": True, "file_types": ["pdf"]}],
            "docreader_connected": True,
        }}
    monkeypatch.setattr(webapp, "_call_tool", fake_call)
    r = client.get("/api/parser-engines", headers=HEADERS)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["result"]["engines"][0]["name"] == "builtin"


def test_parser_engines_requires_identity(client):
    assert client.get("/api/parser-engines").status_code == 400


def test_import_forwards_process_config(client, monkeypatch):
    seen = {}
    async def fake_call(name, arguments, headers, timeout=60):
        seen.update(arguments)
        return {"ok": True, "http_status": 200, "result": {"accepted": True}}
    monkeypatch.setattr(webapp, "_call_tool", fake_call)
    r = client.post("/api/import", headers=HEADERS, json={
        "knowledge_base_id": "kb-1", "upload_id": "u-1",
        "process_config": {"parser_engine_rules": [{"file_types": ["pdf"], "engine": "builtin"}]},
    })
    assert r.status_code == 200
    assert seen["process_config"]["parser_engine_rules"][0]["engine"] == "builtin"


def test_ask_forwards_the_native_mode(client, monkeypatch):
    seen = {}
    async def fake_call(name, arguments, headers, timeout=60):
        seen.update(arguments)
        return {"ok": True, "http_status": 200, "result": {
            "answer": "ok", "session_id": "s-1", "mode": "quick-answer", "knowledge_base_ids": ["kb-1"]}}
    monkeypatch.setattr(webapp, "_call_tool", fake_call)
    r = client.post("/api/ask", headers=HEADERS, json={"question": "q", "mode": "quick-answer"})
    assert r.status_code == 200
    assert seen["mode"] == "quick-answer"
    assert '"mode": "quick-answer"' in r.text or '"mode":"quick-answer"' in r.text
