"""MCP verification console — a thin web shell over WeKnora's MCP surface.

The console exists to prove the MCP packing the main product will consume:
every action on the page is one or more MCP tool calls (or the multipart
upload transport), and the raw JSON-RPC request/response of each call is
visible in the UI.

What the shell does:

  1. serve the static console (GET / + /assets/*)
  2. relay the required MCP headers (Authorization / X-WeKnora-User-Token /
     X-Tenant-ID / X-WeKnora-Knowledge-Base-Ids) from the browser to the MCP
     server unchanged, so the caller's identity is the same on every tool
  3. expose a login proxy that exchanges a local accounts.json entry for a
     fresh WeKnora JWT via POST /api/v1/auth/login. The shell never caches
     that JWT: the browser holds it and sends it back on every request as
     X-WeKnora-User-Token. Credentials live in accounts.json (gitignored,
     never served statically); the shell refuses emails that are not in
     that file so it can never act as an open login proxy.
  4. proxy explicit MCP calls the console needs: tools/list, generic
     tools/call, the multipart upload transport, and an SSE checklist that
     walks the read/wiki/graph/status tools for one document.

Configuration: AGENT_MODEL / AGENT_MODEL_BASE_URL / AGENT_MODEL_API_KEY
identify the model; WEKNORA_MCP_URL + WEKNORA_MCP_TOKEN identify the MCP
endpoint; per-request user identity always comes from the browser.
"""
import asyncio
import base64
import json
import logging
import os
import time
import uuid
from pathlib import Path

import uvicorn
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from sse_starlette.sse import EventSourceResponse
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from agent import build_agent
from main import ConfigurationError, load_connections, required_env

ROOT = Path(__file__).resolve().parent
log = logging.getLogger("webapp")

# Same runtime boundary as the CLI: total budget 120s, model 60s,
# framework recursion_limit 20. Keeping this identical to main.py is
# what makes "the page is the CLI with a UI" hold.
ANSWER_TIMEOUT = 120
MODEL_TIMEOUT = 60
RECURSION_LIMIT = 20
# The ask tool runs WeKnora's own agent pipeline server-side, which can
# take up to ~4 minutes; give it the full budget plus margin.
ASK_TIMEOUT = 260
# One checklist step may poll the parse status for a while (large or
# OCR'd documents take minutes); the poll budget lives in _poll_document.
CHECKLIST_STEP_TIMEOUT = 60

# Identity headers. The user token and workspace are mandatory on every
# request that touches WeKnora; the knowledge-base selection is OPTIONAL
# narrowing, exactly as the MCP contract treats it (absent = not narrowed,
# present-but-empty = error). The console mirrors that: the KB header is
# forwarded when the browser has a selection and omitted otherwise, because
# discovery (list_knowledge_bases) necessarily happens before any selection
# exists. Login / accounts / info are the only routes without identity.
_REQUIRED_HEADERS = (
    "X-WeKnora-User-Token",
    "X-Tenant-ID",
)
_OPTIONAL_HEADERS = (
    "X-WeKnora-Knowledge-Base-Ids",
)

# Tools that mutate state or consume one-shot credentials; the console
# badges them and asks for confirmation before running them.
DESTRUCTIVE_TOOLS = frozenset({
    "upload_file",
    "import_document_file",
    "add_document",
    "update_document",
    "delete_document",
})

# Local credential file for the login proxy. Overridden in tests.
ACCOUNTS_PATH = ROOT / "accounts.json"


# --- identity header relay --------------------------------------------------

def _missing_header_response() -> JSONResponse:
    return JSONResponse(
        {"error": "missing one of " + ", ".join(_REQUIRED_HEADERS)},
        status_code=400,
    )


def _extract_mcp_headers(request: Request) -> dict[str, str] | None:
    """Pull the identity headers off the inbound request.

    Returns None when a required header is empty / missing. Optional
    headers are included only when the browser actually sent a value: an
    empty selection must never be forwarded as "present but empty" (which
    WeKnora rejects by design). The endpoint token is read from the
    environment because it authorizes the MCP endpoint, not the user; the
    shell never invents a user identity.
    """
    out: dict[str, str] = {}
    for h in _REQUIRED_HEADERS:
        v = (request.headers.get(h) or "").strip()
        if not v:
            return None
        out[h] = v
    for h in _OPTIONAL_HEADERS:
        v = (request.headers.get(h) or "").strip()
        if v:
            out[h] = v
    return out


def _build_connection(endpoint_token: str, user_headers: dict[str, str]):
    """Snapshot a copy of mcp.json with the required headers pre-bound to
    this specific request. Each call gets its own dict so concurrent
    requests do not share state.
    """
    connections = load_connections(ROOT / "mcp.json")
    conn = connections["weknora"]
    headers = dict(conn.get("headers") or {})
    headers["Authorization"] = "Bearer " + endpoint_token
    for k, v in user_headers.items():
        headers[k] = v
    conn["headers"] = headers
    return connections


def _endpoint_token() -> str:
    """The MCP endpoint token; the only auth material the shell owns."""
    return required_env("WEKNORA_MCP_TOKEN")


def _mcp_endpoint_target() -> tuple[str, str]:
    """Return (weknora_base_url, endpoint_id) from mcp.json / .env."""
    connections = load_connections(ROOT / "mcp.json")
    url = (connections["weknora"].get("url") or "").strip()
    endpoint_id = ""
    if "/mcp/" in url:
        url, endpoint_id = url.rsplit("/mcp/", 1)
    endpoint_id = os.environ.get("WEKNORA_AGENT_ENDPOINT_ID", "").strip() or endpoint_id
    return url.rstrip("/"), endpoint_id


# --- local accounts + login proxy ------------------------------------------

def _load_accounts() -> list[dict]:
    """Read accounts.json. Tolerates both {"accounts": [...]} and a bare
    list; a missing or malformed file yields an empty list (login then
    refuses everything, which is the safe direction).
    """
    try:
        raw = json.loads(ACCOUNTS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        log.warning("accounts.json not found at %s; login disabled", ACCOUNTS_PATH)
        return []
    except Exception as exc:  # noqa: BLE001
        log.warning("accounts.json is not readable JSON: %s", exc)
        return []
    entries = raw.get("accounts") if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        return []
    out = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        email = str(item.get("email") or "").strip()
        password = str(item.get("password") or "")
        if not email or not password:
            continue
        out.append({"name": str(item.get("name") or email).strip(),
                    "email": email, "password": password})
    return out


def _find_account(email: str) -> dict | None:
    email = email.strip().lower()
    for item in _load_accounts():
        if item["email"].lower() == email:
            return item
    return None


class LoginError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


async def _login_upstream(email: str, password: str) -> dict:
    """Exchange credentials for a fresh JWT at WeKnora. Tests patch this."""
    base, _ = _mcp_endpoint_target()
    payload = json.dumps({"email": email, "password": password},
                         ensure_ascii=False).encode("utf-8")

    def _do() -> tuple[int, str]:
        import urllib.error
        import urllib.request
        req = urllib.request.Request(base + "/api/v1/auth/login",
                                     data=payload, method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "ignore")

    status, raw = await asyncio.to_thread(_do)
    if status != 200:
        raise LoginError(401 if status in (400, 401) else status,
                         "账号或密码错误" if status in (400, 401)
                         else f"WeKnora 登录失败（HTTP {status}）")
    try:
        return json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        raise LoginError(502, f"登录响应不是合法 JSON：{exc}") from exc


async def accounts(request: Request):
    """List the allowlisted accounts. Never returns passwords."""
    return JSONResponse({"accounts": [
        {"name": item["name"], "email": item["email"]}
        for item in _load_accounts()
    ]})


async def login(request: Request):
    """Exchange an allowlisted account's password for a fresh JWT.

    The JWT is returned to the browser and NOT cached here: every later
    request re-sends it as X-WeKnora-User-Token, so identity handling
    stays request-scoped and an expired token degrades to one visible
    401 instead of a silent server-side refresh.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "request body must be JSON"}, status_code=400)
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""
    if not email or not password:
        return JSONResponse({"error": "email and password are required"}, status_code=400)
    account = _find_account(email)
    if account is None:
        # Not in the local allowlist: never forward to WeKnora, or the
        # console would be an open password-testing proxy.
        return JSONResponse({"error": "该邮箱不在本地账号档案（accounts.json）中"},
                            status_code=403)
    try:
        upstream = await _login_upstream(email, password)
    except LoginError as exc:
        return JSONResponse({"error": exc.message}, status_code=exc.status_code)
    token = upstream.get("token") or ""
    if not token:
        return JSONResponse({"error": "WeKnora 登录响应中没有 token"}, status_code=502)
    user = upstream.get("user") or {}
    tenant = upstream.get("active_tenant") or {}
    tenant_id = str(user.get("tenant_id") or tenant.get("id") or "")
    return JSONResponse({
        "profile": {
            "name": account["name"],
            "email": email,
            "user_id": str(user.get("id") or ""),
            "tenant_id": tenant_id,
        },
        "token": token,
    })


# --- MCP raw JSON-RPC ------------------------------------------------------

def _decode_tool_result(result: dict) -> dict:
    """Normalize an MCP tool result into one shape the console can render.

    WeKnora puts the structured payload in structuredContent and mirrors
    it as indented JSON text; business failures arrive as isError=true
    with structuredContent.error = {code, message, retryable}.
    """
    structured = result.get("structuredContent")
    text = ""
    for item in (result.get("content") or []):
        if isinstance(item, dict) and item.get("type") == "text":
            text = item.get("text", "")
            break
    if structured is None and text:
        try:
            structured = json.loads(text)
        except Exception:  # noqa: BLE001
            structured = {"text": text}
    if structured is None:
        # Protocol-level results (tools/list, initialize, ...) carry no
        # content/structuredContent wrapper; pass the payload through
        # instead of collapsing it to None.
        passthrough = {k: v for k, v in result.items() if k != "isError"}
        structured = passthrough or None
    is_error = bool(result.get("isError"))
    error_code, error_message = None, None
    if is_error:
        if isinstance(structured, dict):
            err = structured.get("error")
            if isinstance(err, dict):
                error_code = err.get("code")
                error_message = err.get("message")
            elif isinstance(err, str):
                error_message = err
        error_message = error_message or (text[:300] if text else "tool returned an error")
    return {
        "is_error": is_error,
        "structured": structured,
        "text": text,
        "error_code": error_code,
        "error_message": error_message,
    }


async def _mcp_rpc(method: str, params: dict, user_headers: dict[str, str],
                   timeout: int = 60) -> dict:
    """One raw JSON-RPC call against the MCP endpoint.

    Returns {"ok": bool, ...} with the normalized result on success and a
    description of the failure otherwise. Never raises for upstream
    errors: the console renders failures as data.
    """
    import urllib.error
    import urllib.request

    base, endpoint_id = _mcp_endpoint_target()
    payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"{base}/mcp/{endpoint_id}", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    req.add_header("Authorization", "Bearer " + _endpoint_token())
    for k, v in user_headers.items():
        req.add_header(k, v)

    def _do_call() -> dict:
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "ignore")
                status = resp.status
        except urllib.error.HTTPError as exc:
            return {"_http_status": exc.code,
                    "_body": exc.read().decode("utf-8", "ignore")[:500]}
        if raw.startswith("event:"):
            for line in raw.splitlines():
                if line.startswith("data:"):
                    raw = line[len("data:"):].strip()
                    break
        try:
            parsed = json.loads(raw)
        except Exception:  # noqa: BLE001
            return {"_http_status": status, "_body": raw[:500]}
        parsed["_http_status"] = status
        return parsed

    rpc = await asyncio.to_thread(_do_call)
    http_status = rpc.get("_http_status", 0)
    if "_body" in rpc and "result" not in rpc:
        return {"ok": False, "http_status": http_status,
                "error": f"MCP HTTP {http_status}", "raw": rpc.get("_body", "")}
    if "error" in rpc:
        err = rpc["error"] or {}
        return {"ok": False, "http_status": http_status,
                "error": err.get("message", "rpc error"), "rpc_error": err}
    decoded = _decode_tool_result(rpc.get("result") or {})
    out = {"ok": not decoded["is_error"], "http_status": http_status,
           "result": decoded["structured"], "text": decoded["text"]}
    if decoded["is_error"]:
        out["error"] = decoded["error_message"]
        out["error_code"] = decoded["error_code"]
    return out


async def _call_tool(name: str, arguments: dict, user_headers: dict[str, str],
                     timeout: int = 60) -> dict:
    return await _mcp_rpc("tools/call", {"name": name, "arguments": arguments},
                          user_headers, timeout=timeout)


# --- model + agent chat (LangChain mode) -----------------------------------

state = {"model": None, "model_lock": None}


async def _get_model_async() -> ChatOpenAI:
    if state["model"] is not None:
        return state["model"]
    if state["model_lock"] is None:
        state["model_lock"] = asyncio.Lock()
    async with state["model_lock"]:
        if state["model"] is None:
            state["model"] = ChatOpenAI(
                model=required_env("AGENT_MODEL"),
                base_url=required_env("AGENT_MODEL_BASE_URL"),
                api_key=required_env("AGENT_MODEL_API_KEY"),
                temperature=0, timeout=MODEL_TIMEOUT, max_retries=0,
            )
    return state["model"]


def _safe_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            item.get("text", "") for item in content
            if isinstance(item, dict) and item.get("type") == "text")
    return str(content)


def _brief_args(args) -> str:
    if not isinstance(args, dict) or not args:
        return ""
    for key in ("query", "question", "keyword", "pattern", "slug"):
        if key in args:
            return str(args[key])[:80]
    return json.dumps(args, ensure_ascii=False)[:80]


async def _stream_agent_chat(question: str, user_headers: dict[str, str]):
    """Run the LangChain agent (the CLI's exact chain) and stream the
    tool trace + final answer as SSE. No login, no JWT cache, no retry.
    """
    yield {"data": json.dumps(
        {"type": "status", "text": "正在检索 WeKnora 知识库…"}, ensure_ascii=False)}
    try:
        connections = _build_connection(_endpoint_token(), user_headers)
        agent = await build_agent(await _get_model_async(), connections)
    except Exception as exc:  # noqa: BLE001
        log.exception("chat init failed")
        yield {"data": json.dumps(
            {"type": "error",
             "message": f"初始化失败（{type(exc).__name__}）：{exc}",
             "hint": "check AGENT_MODEL / AGENT_MODEL_BASE_URL / AGENT_MODEL_API_KEY and MCP headers"},
            ensure_ascii=False)}
        return

    inputs = {"messages": [{"role": "user", "content": question}]}
    config = {"recursion_limit": RECURSION_LIMIT}
    answer = ""
    try:
        async with asyncio.timeout(ANSWER_TIMEOUT):
            async for chunk in agent.astream(inputs, config=config, stream_mode="updates"):
                for payload in chunk.values():
                    for msg in payload.get("messages", []):
                        kind = getattr(msg, "type", "")
                        if kind == "ai" and getattr(msg, "tool_calls", None):
                            for call in msg.tool_calls:
                                yield {"data": json.dumps(
                                    {"type": "tool", "name": call.get("name", ""),
                                     "args": _brief_args(call.get("args"))},
                                    ensure_ascii=False)}
                        elif kind == "tool":
                            yield {"data": json.dumps(
                                {"type": "tool_result",
                                 "name": getattr(msg, "name", ""),
                                 "status": getattr(msg, "status", "") or "success"},
                                ensure_ascii=False)}
                        elif kind == "ai":
                            text = msg.text() if hasattr(msg, "text") else _safe_text(msg.content)
                            if text:
                                answer = text
    except asyncio.TimeoutError:
        yield {"data": json.dumps(
            {"type": "error", "message": f"运行超时（{ANSWER_TIMEOUT} 秒）"},
            ensure_ascii=False)}
        return
    except Exception as exc:  # noqa: BLE001
        log.exception("agent run failed")
        yield {"data": json.dumps(
            {"type": "error",
             "message": f"运行失败（{type(exc).__name__}），请检查请求头与 WeKnora 端点"},
            ensure_ascii=False)}
        return

    if answer:
        yield {"data": json.dumps({"type": "answer", "text": answer}, ensure_ascii=False)}
    else:
        yield {"data": json.dumps(
            {"type": "error", "message": "模型没有返回内容，请重试"},
            ensure_ascii=False)}


async def chat(request: Request):
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "request body must be JSON"}, status_code=400)
    question = (body.get("question") or "").strip()
    if not question:
        return JSONResponse({"error": "question is required"}, status_code=400)
    return EventSourceResponse(_stream_agent_chat(question, user_headers), ping=15)


# --- direct ask tool (MCP mode) --------------------------------------------

async def _stream_ask(question: str, session_id: str, user_headers: dict[str, str]):
    """One direct `ask` MCP call streamed as SSE. This is the shape the
    main product will use when it wants WeKnora's own answer pipeline
    rather than letting its own model orchestrate the tools.
    """
    yield {"data": json.dumps(
        {"type": "status", "text": "正在调用 MCP ask 工具…"}, ensure_ascii=False)}
    arguments = {"question": question}
    if session_id:
        arguments["session_id"] = session_id
    r = await _call_tool("ask", arguments, user_headers, timeout=ASK_TIMEOUT)
    if not r["ok"]:
        yield {"data": json.dumps(
            {"type": "error",
             "message": r.get("error") or r.get("error_message") or "ask 调用失败",
             "error_code": r.get("error_code")},
            ensure_ascii=False)}
        return
    data = r.get("result") or {}
    if not isinstance(data, dict):
        data = {"answer": str(data)}
    yield {"data": json.dumps(
        {"type": "answer",
         "text": data.get("answer") or "",
         "references": data.get("references") or [],
         "session_id": data.get("session_id") or "",
         "agent_id": data.get("agent_id") or ""},
        ensure_ascii=False)}


async def ask(request: Request):
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "request body must be JSON"}, status_code=400)
    question = (body.get("question") or "").strip()
    session_id = (body.get("session_id") or "").strip()
    if not question:
        return JSONResponse({"error": "question is required"}, status_code=400)
    return EventSourceResponse(_stream_ask(question, session_id, user_headers), ping=15)


# --- verification checklist (SSE) ------------------------------------------

def _kb_entry(result, kb_id: str) -> dict | None:
    for kb in (result or {}).get("knowledge_bases", []) or []:
        if str(kb.get("id")) == kb_id:
            return kb
    return None


def _literal_term(text: str) -> str:
    """First token of `text` that grep_chunks accepts as a literal term.

    The document title often is a file name ("doc01-overview.md"); drop the
    extension before stripping punctuation or the pattern keeps the dot's
    neighbours glued together and matches nothing.
    """
    for token in (text or "").split():
        if "." in token:
            token = token.rsplit(".", 1)[0]
        cleaned = "".join(ch for ch in token if ch.isalnum() or ch in "-_")
        if cleaned:
            return cleaned[:40]
    return "document"


# The checklist is a burst of MCP calls; the endpoint's per-minute rate
# limit is shared with everything else the console does. Poll politely
# (an interval between status reads) and retry the explicitly retryable
# RATE_LIMITED rejection once with a short backoff instead of turning a
# shared quota into a wall of red rows.
CHECKLIST_POLL_INTERVAL = 2.5
RATE_LIMIT_RETRY_DELAY = 2.5


async def _call_tool_retrying_rate_limit(
    name: str, arguments: dict, user_headers: dict[str, str],
    timeout: int = CHECKLIST_STEP_TIMEOUT, attempts: int = 3,
) -> dict:
    r = await _call_tool(name, arguments, user_headers, timeout=timeout)
    for _ in range(attempts - 1):
        if r.get("ok") or r.get("error_code") != "RATE_LIMITED":
            return r
        await asyncio.sleep(RATE_LIMIT_RETRY_DELAY)
        r = await _call_tool(name, arguments, user_headers, timeout=timeout)
    return r


async def _poll_document(knowledge_id: str, headers: dict[str, str],
                         max_seconds: int = 150) -> dict:
    """Poll get_document_status until the parse leaves the running states."""
    deadline = time.monotonic() + max_seconds
    last = {}
    while True:
        r = await _call_tool_retrying_rate_limit(
            "get_document_status", {"knowledge_id": knowledge_id}, headers)
        if not r["ok"]:
            return {"ok": False, "error": r.get("error"), "result": r.get("result")}
        status = ((r.get("result") or {}).get("status") or {})
        last = status
        parse = status.get("parse_status")
        if parse in ("completed", "failed", "cancelled"):
            return {"ok": parse == "completed", "status": status,
                    "error": status.get("error_message") if parse != "completed" else None}
        if time.monotonic() >= deadline:
            return {"ok": False, "status": last, "error": f"解析超时（{max_seconds}s，最后状态 {parse}）"}
        await asyncio.sleep(CHECKLIST_POLL_INTERVAL)


async def _checklist_stream(kb_id: str, knowledge_id: str, upload_id: str,
                            user_headers: dict[str, str]):
    """Walk the read-side MCP tools for one knowledge base + document.

    Each step is emitted as {"type":"step", tool, status, latency_ms,
    summary, raw}; a step that cannot apply is "skip" WITH a reason, so
    a red row always means the tool failed, never "not configured".
    """
    # Narrow the request scope to the checklist's target KB: the
    # checklist is about exactly one KB, and an explicit selection is
    # what the plan's scope model expects from a client.
    headers = dict(user_headers)
    headers["X-WeKnora-Knowledge-Base-Ids"] = kb_id

    async def run_step(tool: str, arguments: dict, timeout: int = CHECKLIST_STEP_TIMEOUT):
        started = time.monotonic()
        r = await _call_tool_retrying_rate_limit(tool, arguments, headers, timeout=timeout)
        latency = round((time.monotonic() - started) * 1000)
        return r, latency

    def emit(tool, status, latency, summary, raw=None):
        return {"data": json.dumps(
            {"type": "step", "tool": tool, "status": status,
             "latency_ms": latency, "summary": summary, "raw": raw},
            ensure_ascii=False)}

    summary = {"pass": 0, "fail": 0, "skip": 0}
    caps: dict = {}
    wiki_available = ""
    graph_available = ""

    # 1. list_knowledge_bases — also reads the capability flags.
    r, latency = await run_step("list_knowledge_bases", {})
    kb = _kb_entry(r.get("result"), kb_id) if r["ok"] else None
    if not r["ok"]:
        summary["fail"] += 1
        yield emit("list_knowledge_bases", "fail", latency,
                   r.get("error") or "调用失败", r.get("result"))
        yield {"data": json.dumps({"type": "done", "summary": summary}, ensure_ascii=False)}
        return
    if kb is None:
        summary["fail"] += 1
        yield emit("list_knowledge_bases", "fail", latency,
                   f"知识库 {kb_id} 不在端点范围内", r.get("result"))
        yield {"data": json.dumps({"type": "done", "summary": summary}, ensure_ascii=False)}
        return
    caps = kb.get("capability_flags") or {}
    summary["pass"] += 1
    yield emit("list_knowledge_bases", "pass", latency,
               f"{kb.get('name')} caps={','.join(k for k, v in caps.items() if v)}",
               kb)

    # Abort-early flag: a document that failed to parse makes the
    # read-side steps meaningless; they get skip("解析失败") instead.
    parse_failed = False

    # 2. get_upload_status (only when the caller has an upload receipt).
    if upload_id:
        r, latency = await run_step("get_upload_status", {"upload_id": upload_id})
        if r["ok"]:
            summary["pass"] += 1
            yield emit("get_upload_status", "pass", latency,
                       f"state={(r.get('result') or {}).get('state')}", r.get("result"))
        else:
            summary["fail"] += 1
            yield emit("get_upload_status", "fail", latency, r.get("error"), r.get("result"))
    else:
        summary["skip"] += 1
        yield emit("get_upload_status", "skip", 0, "本次流程没有 upload_id（非上传路径）")

    # 3. get_document_status — polls until the parse finishes.
    if knowledge_id:
        started = time.monotonic()
        polled = await _poll_document(knowledge_id, headers)
        latency = round((time.monotonic() - started) * 1000)
        if polled["ok"]:
            summary["pass"] += 1
            yield emit("get_document_status", "pass", latency,
                       f"parse=completed index={(polled['status'] or {}).get('index_status')}",
                       polled.get("status"))
        else:
            parse_failed = True
            summary["fail"] += 1
            yield emit("get_document_status", "fail", latency,
                       polled.get("error") or "解析未完成", polled.get("status"))
    else:
        parse_failed = True
        summary["skip"] += 1
        yield emit("get_document_status", "skip", 0, "本次流程没有 knowledge_id")

    title = ""
    read_result = {}

    # 4. read_document
    if knowledge_id and not parse_failed:
        r, latency = await run_step("read_document", {"knowledge_id": knowledge_id, "limit": 2})
        if r["ok"]:
            read_result = r.get("result") or {}
            doc = read_result.get("document") or {}
            title = str(doc.get("title") or read_result.get("title") or "")
            summary["pass"] += 1
            yield emit("read_document", "pass", latency,
                       f"chunks≤2 truncated={read_result.get('truncated')}",
                       read_result)
        else:
            summary["fail"] += 1
            yield emit("read_document", "fail", latency, r.get("error"), r.get("result"))
    else:
        summary["skip"] += 1
        yield emit("read_document", "skip", 0, "解析未完成，跳过")

    # 5. list_documents
    if not parse_failed:
        r, latency = await run_step("list_documents",
                                    {"knowledge_base_id": kb_id, "page_size": 5})
        if r["ok"]:
            total = (r.get("result") or {}).get("total")
            summary["pass"] += 1
            yield emit("list_documents", "pass", latency, f"total={total}", r.get("result"))
        else:
            summary["fail"] += 1
            yield emit("list_documents", "fail", latency, r.get("error"), r.get("result"))
    else:
        summary["skip"] += 1
        yield emit("list_documents", "skip", 0, "解析未完成，跳过")

    # 6/7. search_knowledge + grep_chunks, gated on vector/keyword caps.
    retrievable = bool(caps.get("vector") or caps.get("keyword"))
    for tool in ("search_knowledge", "grep_chunks"):
        if parse_failed:
            summary["skip"] += 1
            yield emit(tool, "skip", 0, "解析未完成，跳过")
            continue
        if not retrievable:
            summary["skip"] += 1
            yield emit(tool, "skip", 0, "该知识库未启用向量/关键词检索")
            continue
        query = title or "document"
        if tool == "grep_chunks":
            query = _literal_term(query)
        r, latency = await run_step(tool, {"query": query,
                                           "knowledge_base_ids": [kb_id], "limit": 3})
        if r["ok"]:
            hits = (r.get("result") or {}).get("results") or []
            summary["pass"] += 1
            yield emit(tool, "pass", latency, f"hits={len(hits)} query={query!r}",
                       r.get("result"))
        else:
            summary["fail"] += 1
            yield emit(tool, "fail", latency, r.get("error"), r.get("result"))

    # 8. get_knowledge_base_status — also yields wiki/graph availability.
    r, latency = await run_step("get_knowledge_base_status", {"knowledge_base_id": kb_id})
    if r["ok"]:
        st = (r.get("result") or {}).get("status") or {}
        wiki_available = str(((st.get("wiki") or {}).get("available")) or "")
        graph_available = str(((st.get("graph") or {}).get("available")) or "")
        summary["pass"] += 1
        yield emit("get_knowledge_base_status", "pass", latency,
                   f"docs={st.get('documents')} chunks={st.get('chunks')} "
                   f"wiki={wiki_available or 'n/a'} graph={graph_available or 'n/a'}",
                   st)
    else:
        summary["fail"] += 1
        yield emit("get_knowledge_base_status", "fail", latency,
                   r.get("error"), r.get("result"))

    # 9-11. wiki tools, two-tier gate: capability flag, then runtime
    # availability from the KB status (a KB can have wiki enabled but
    # not generated anything yet — that is a skip, not a failure).
    wiki_gate = ""
    if not caps.get("wiki"):
        wiki_gate = "该知识库未启用 Wiki"
    elif wiki_available == "unavailable":
        wiki_gate = "Wiki 已启用但当前不可用（尚未生成或生成失败）"
    wiki_steps = [
        ("wiki_index", {"knowledge_base_id": kb_id}),
        ("wiki_list_pages", {"knowledge_base_id": kb_id, "page_size": 5}),
        ("wiki_graph", {"knowledge_base_id": kb_id}),
    ]
    wiki_slug = ""
    for tool, arguments in wiki_steps:
        if wiki_gate:
            summary["skip"] += 1
            yield emit(tool, "skip", 0, wiki_gate)
            continue
        r, latency = await run_step(tool, arguments)
        if r["ok"]:
            data = r.get("result") or {}
            if tool == "wiki_index":
                detail = f"groups={len(data.get('groups') or [])}"
            elif tool == "wiki_list_pages":
                detail = f"total={data.get('total')}"
                for page in data.get("pages") or []:
                    if page.get("slug"):
                        wiki_slug = page["slug"]
                        break
            else:
                detail = f"nodes={len(data.get('nodes') or [])} edges={len(data.get('edges') or [])}"
            summary["pass"] += 1
            yield emit(tool, "pass", latency, detail, data)
        else:
            summary["fail"] += 1
            yield emit(tool, "fail", latency, r.get("error"), r.get("result"))

    # wiki_search over the wiki form, and wiki_read_page on a real slug the
    # list above returned — the two wiki tools the other steps cannot cover.
    if wiki_gate:
        summary["skip"] += 1
        yield emit("wiki_search", "skip", 0, wiki_gate)
    else:
        r, latency = await run_step("wiki_search", {
            "query": title or "总结", "knowledge_base_ids": [kb_id], "limit": 5})
        if r["ok"]:
            data = r.get("result") or {}
            hits = data.get("results") or data.get("pages") or []
            summary["pass"] += 1
            yield emit("wiki_search", "pass", latency, f"hits={len(hits)}", data)
        else:
            summary["fail"] += 1
            yield emit("wiki_search", "fail", latency, r.get("error"), r.get("result"))

    if wiki_gate:
        summary["skip"] += 1
        yield emit("wiki_read_page", "skip", 0, wiki_gate)
    elif not wiki_slug:
        summary["skip"] += 1
        yield emit("wiki_read_page", "skip", 0, "Wiki 页面列表为空，没有可读的 slug")
    else:
        r, latency = await run_step("wiki_read_page",
                                    {"slug": wiki_slug, "knowledge_base_id": kb_id})
        if r["ok"]:
            data = r.get("result") or {}
            refs = data.get("source_refs_v2") or {}
            summary["pass"] += 1
            yield emit("wiki_read_page", "pass", latency,
                       f"slug={wiki_slug} refs={len(refs)}", data)
        else:
            summary["fail"] += 1
            yield emit("wiki_read_page", "fail", latency, r.get("error"), r.get("result"))

    # 12. query_knowledge_graph — capability flag + runtime availability.
    if not caps.get("graph"):
        summary["skip"] += 1
        yield emit("query_knowledge_graph", "skip", 0, "该知识库未启用图谱抽取")
    elif graph_available == "unavailable":
        summary["skip"] += 1
        yield emit("query_knowledge_graph", "skip", 0,
                   "图谱已启用但当前不可用（尚未抽取或图存储不可达）")
    else:
        query = _literal_term(title or "entity")
        r, latency = await run_step("query_knowledge_graph",
                                    {"knowledge_base_ids": [kb_id], "query": query})
        if r["ok"]:
            relations = (r.get("result") or {}).get("relations") or []
            summary["pass"] += 1
            yield emit("query_knowledge_graph", "pass", latency,
                       f"relations={len(relations)} query={query!r}", r.get("result"))
        elif r.get("error_code") in ("GRAPH_EXTRACTION_NOT_CONFIGURED", "GRAPH_UNAVAILABLE"):
            # Config state, not a tool defect: report as skip with reason.
            summary["skip"] += 1
            yield emit("query_knowledge_graph", "skip", latency,
                       f"配置态：{r.get('error_code')} {r.get('error') or ''}".strip(),
                       r.get("result"))
        else:
            summary["fail"] += 1
            yield emit("query_knowledge_graph", "fail", latency,
                       r.get("error"), r.get("result"))

    yield {"data": json.dumps({"type": "done", "summary": summary}, ensure_ascii=False)}


async def checklist(request: Request):
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "request body must be JSON"}, status_code=400)
    kb_id = (body.get("knowledge_base_id") or "").strip()
    if not kb_id:
        return JSONResponse({"error": "knowledge_base_id is required"}, status_code=400)
    knowledge_id = (body.get("knowledge_id") or "").strip()
    upload_id = (body.get("upload_id") or "").strip()
    return EventSourceResponse(
        _checklist_stream(kb_id, knowledge_id, upload_id, user_headers), ping=15)


# --- explicit tool calls (upload, import, status, generic runner) ----------

async def upload(request: Request):
    """Forward a file upload through one of the MCP surface's two channels.

    channel=multipart (default): the raw multipart body is forwarded
    UNCHANGED to POST /mcp/:endpoint_id/uploads. Field order is part of
    that contract (knowledge_base_id must precede file), so the shell
    must not parse-and-rebuild the form; it only adds the auth headers
    and an Idempotency-Key (a UUID; generated when absent).

    channel=tool: read the form, base64-encode the bytes and call the
    upload_file MCP tool — the pure-JSON path.
    """
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    channel = (request.query_params.get("channel") or "multipart").strip()
    idem = (request.headers.get("Idempotency-Key")
            or request.query_params.get("idempotency_key") or "").strip()

    if channel == "tool":
        form = await request.form()
        file_field = form.get("file")
        form_kb = (form.get("knowledge_base_id") or "").strip()
        header_kb = (user_headers.get("X-WeKnora-Knowledge-Base-Ids") or "").split(",")[0].strip()
        kb_id = form_kb or header_kb
        if file_field is None or not getattr(file_field, "filename", ""):
            return JSONResponse({"error": "file is required"}, status_code=400)
        if not kb_id:
            return JSONResponse({"error": "knowledge_base_id is required"}, status_code=400)
        raw = await file_field.read()
        if not raw:
            return JSONResponse({"error": "empty file"}, status_code=400)
        log.info("upload_file receive: name=%s size=%d", file_field.filename, len(raw))
        arguments = {
            "knowledge_base_id": kb_id,
            "file_name": file_field.filename,
            "content": base64.b64encode(raw).decode("ascii"),
        }
        if idem:
            arguments["idempotency_key"] = idem
        r = await _call_tool("upload_file", arguments, user_headers, timeout=120)
        if not r["ok"]:
            return JSONResponse({"ok": False, "error": r.get("error"), "result": r.get("result")},
                                status_code=200)
        return JSONResponse({"ok": True, "result": r.get("result")})

    # --- multipart passthrough ---
    content_type = request.headers.get("content-type") or ""
    if "multipart/form-data" not in content_type:
        return JSONResponse({"error": "multipart/form-data body is required for channel=multipart"},
                            status_code=400)
    raw = await request.body()
    if not raw:
        return JSONResponse({"error": "empty body"}, status_code=400)
    idem = idem or str(uuid.uuid4())
    base, endpoint_id = _mcp_endpoint_target()

    def _forward() -> tuple[int, str]:
        import urllib.error
        import urllib.request
        req = urllib.request.Request(f"{base}/mcp/{endpoint_id}/uploads",
                                     data=raw, method="POST")
        req.add_header("Content-Type", content_type)
        req.add_header("Idempotency-Key", idem)
        req.add_header("Authorization", "Bearer " + _endpoint_token())
        for k, v in user_headers.items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return resp.status, resp.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "ignore")

    status, body_text = await asyncio.to_thread(_forward)
    try:
        parsed = json.loads(body_text)
    except Exception:  # noqa: BLE001
        parsed = {"raw": body_text[:500]}
    log.info("multipart upload forwarded: status=%s idempotency=%s", status, idem)
    return JSONResponse(parsed, status_code=status)


async def import_upload(request: Request):
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "request body must be JSON"}, status_code=400)
    kb_id = (body.get("knowledge_base_id") or "").strip()
    upload_id = (body.get("upload_id") or "").strip()
    if not kb_id or not upload_id:
        return JSONResponse(
            {"error": "knowledge_base_id and upload_id are required"}, status_code=400)
    r = await _call_tool("import_document_file",
                         {"knowledge_base_id": kb_id, "upload_id": upload_id},
                         user_headers, timeout=120)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error"),
                             "error_code": r.get("error_code"), "result": r.get("result")})
    return JSONResponse({"ok": True, "result": r.get("result")})


async def _simple_tool_route(request: Request, tool: str, argument: str):
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    value = (request.query_params.get(argument) or "").strip()
    if not value:
        return JSONResponse({"error": f"{argument} is required"}, status_code=400)
    r = await _call_tool(tool, {argument: value}, user_headers)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error"),
                             "error_code": r.get("error_code"), "result": r.get("result")})
    return JSONResponse({"ok": True, "result": r.get("result")})


async def upload_status(request: Request):
    return await _simple_tool_route(request, "get_upload_status", "upload_id")


async def document_status(request: Request):
    return await _simple_tool_route(request, "get_document_status", "knowledge_id")


async def kb_status(request: Request):
    return await _simple_tool_route(request, "get_knowledge_base_status", "knowledge_base_id")


async def kbs(request: Request):
    """list_knowledge_bases through MCP: what can this caller see, and
    which capabilities does each KB have. Drives the KB selector and the
    capability gating in the checklist.
    """
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    r = await _call_tool("list_knowledge_bases", {}, user_headers)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error"),
                             "error_code": r.get("error_code")}, status_code=200)
    return JSONResponse({"ok": True, "result": r.get("result")})


async def tools(request: Request):
    """tools/list through MCP, with the console's destructive badge."""
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    r = await _mcp_rpc("tools/list", {}, user_headers)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error")}, status_code=200)
    listed = (r.get("result") or {}).get("tools") or []
    out = []
    for item in listed:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")
        out.append({
            "name": name,
            "description": str(item.get("description") or ""),
            "inputSchema": item.get("inputSchema") or {},
            "destructive": name in DESTRUCTIVE_TOOLS,
        })
    return JSONResponse({"ok": True, "tools": out})


async def run_tool(request: Request):
    """Generic tools/call runner for the bench + document management."""
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "request body must be JSON"}, status_code=400)
    name = (body.get("name") or "").strip()
    arguments = body.get("arguments") or {}
    if not name:
        return JSONResponse({"error": "name is required"}, status_code=400)
    if not isinstance(arguments, dict):
        return JSONResponse({"error": "arguments must be an object"}, status_code=400)
    started = time.monotonic()
    timeout = ASK_TIMEOUT if name == "ask" else 180
    r = await _call_tool(name, arguments, user_headers, timeout=timeout)
    latency = round((time.monotonic() - started) * 1000)
    return JSONResponse({
        "ok": r["ok"],
        "tool": name,
        "arguments": arguments,
        "result": r.get("result"),
        "error": r.get("error"),
        "error_code": r.get("error_code"),
        "latency_ms": latency,
        "http_status": r.get("http_status"),
    })


async def endpoint_info(request: Request):
    """Read-only endpoint metadata for the header badge.

    Uses the caller's own JWT against the WeKnora management API (the
    endpoints list is Viewer-readable). Falls back to env-derived facts
    so an expired token degrades to a hint, not an error page.
    """
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    base, endpoint_id = _mcp_endpoint_target()
    fallback = {"ok": False, "endpoint_id": endpoint_id, "mcp_url": base,
                "error": "管理接口不可读（token 过期或无权限）"}

    def _do() -> tuple[int, str]:
        import urllib.error
        import urllib.request
        req = urllib.request.Request(f"{base}/api/v1/mcp-endpoints/{endpoint_id}")
        req.add_header("Authorization",
                       "Bearer " + user_headers.get("X-WeKnora-User-Token", ""))
        req.add_header("X-Tenant-ID", user_headers.get("X-Tenant-ID", ""))
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.status, resp.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "ignore")

    status, raw = await asyncio.to_thread(_do)
    if status != 200:
        return JSONResponse(fallback)
    try:
        data = (json.loads(raw).get("data") or {})
    except Exception:  # noqa: BLE001
        return JSONResponse(fallback)
    return JSONResponse({
        "ok": True,
        "endpoint_id": endpoint_id,
        "name": data.get("name"),
        "require_user_identity": bool(data.get("require_user_identity")),
        "enabled": bool(data.get("enabled")),
        "tools": data.get("tools") or [],
        "knowledge_base_ids": data.get("knowledge_base_ids") or [],
        "rate_limit_per_minute": data.get("rate_limit_per_minute"),
        "token_hint": data.get("token_hint"),
    })


# --- page metadata + index + healthz ---------------------------------------

async def info(request: Request):
    kbs_env = [k for k in os.environ.get("WEKNORA_KB_IDS", "").split(",") if k.strip()]
    _, endpoint_id = _mcp_endpoint_target()
    return JSONResponse({
        "model": os.environ.get("AGENT_MODEL", ""),
        "mcp_url": os.environ.get("WEKNORA_MCP_URL", ""),
        "endpoint_id": endpoint_id,
        "knowledge_bases": len(kbs_env),
        "accounts_available": bool(_load_accounts()),
    })


async def index(request: Request):
    return FileResponse(ROOT / "web" / "index.html")


async def healthz(request: Request):
    return JSONResponse({"status": "ok"})


# --- app + entrypoint ------------------------------------------------------

def build_app() -> Starlette:
    assets = ROOT / "web" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    return Starlette(routes=[
        Route("/", index),
        Route("/api/info", info),
        Route("/api/accounts", accounts),
        Route("/api/login", login, methods=["POST"]),
        Route("/api/kbs", kbs),
        Route("/api/tools", tools),
        Route("/api/tool", run_tool, methods=["POST"]),
        Route("/api/endpoint", endpoint_info),
        Route("/api/checklist", checklist, methods=["POST"]),
        Route("/api/ask", ask, methods=["POST"]),
        Route("/api/chat", chat, methods=["POST"]),
        Route("/api/upload", upload, methods=["POST"]),
        Route("/api/import", import_upload, methods=["POST"]),
        Route("/api/upload_status", upload_status),
        Route("/api/document_status", document_status),
        Route("/api/kb_status", kb_status),
        Route("/healthz", healthz),
        Mount("/assets", app=StaticFiles(directory=str(assets)), name="assets"),
    ])


def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    load_dotenv(ROOT / ".env", override=False)
    port = int(os.environ.get("WEKNORA_AGENT_WEB_PORT", "18100"))
    app = build_app()
    log.info("MCP verification console ready: http://127.0.0.1:%s", port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()