"""MCP verification console — a thin web shell over WeKnora's knowledge core.

The console exists to prove the MCP packing the main product will consume:
every action on the page is one or more calls to the FIVE-TOOL core surface
(/mcp/core/<endpoint_id> — knowledge_base, ingest_document, search_knowledge,
read_document, ask), and the raw JSON-RPC request/response of each call is
visible in the UI. The legacy 22-tool catalogue stays mounted at
/mcp/<endpoint_id> for old clients; this console no longer calls it.

What the shell does:

  1. serve the static console (GET / + /assets/*)
  2. relay the required MCP headers (Authorization / X-WeKnora-User-Token /
     X-Tenant-ID / X-WeKnora-Knowledge-Base-Ids) from the browser to the MCP
     server unchanged, so the caller's identity is the same on every tool
  3. accept an externally issued user JWT on each request
  4. proxy tools/list, tools/call (core actions) and SSE verification, and
     assemble the base64 file payload ingest_document.submit expects.

Configuration: AGENT_MODEL / AGENT_MODEL_BASE_URL / AGENT_MODEL_API_KEY
identify the model; WEKNORA_MCP_URL + WEKNORA_MCP_TOKEN identify the MCP
endpoint; per-request user identity always comes from the browser.
"""
import asyncio
import base64
import json
import logging
import os
import re
import time
import urllib.parse
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
# exists. Only info and static assets are public.
_REQUIRED_HEADERS = (
    "X-WeKnora-User-Token",
    "X-Tenant-ID",
)
_OPTIONAL_HEADERS = (
    "X-WeKnora-Knowledge-Base-Ids",
)

# Core tools that mutate state or consume one-shot credentials; the console
# badges them and asks for confirmation before running them. knowledge_base
# mixes reads with create: the creation dialog asks for confirmation in the
# UI, so only ingest_document carries the badge here.
DESTRUCTIVE_TOOLS = frozenset({
    "ingest_document",
})

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
    requests do not share state. Both the LangChain agent and the console
    speak to the five-tool core surface, so the default rewrite applies.
    """
    return load_connections(ROOT / "mcp.json", header_overrides={
        "Authorization": "Bearer " + endpoint_token, **user_headers})


def _endpoint_token() -> str:
    """The MCP endpoint token; the only auth material the shell owns."""
    return required_env("WEKNORA_MCP_TOKEN")


def _mcp_endpoint_target() -> tuple[str, str]:
    """Return (weknora_base_url, endpoint_id) from mcp.json / .env.

    The console's deterministic flows call the five-tool knowledge core
    (/mcp/core/<id>), so both the plain /mcp/<id> form and an already
    rewritten /mcp/core/<id> URL resolve to the same base + endpoint id.
    The configuration is read WITHOUT the LangChain rewrite here because the
    request path applies /mcp/core/ itself; rewriting twice would concatenate
    the prefix.
    """
    connections = load_connections(ROOT / "mcp.json", header_overrides={"Authorization": ""},
                                  core_url=False)
    url = (connections["weknora"].get("url") or "").strip()
    endpoint_id = ""
    if "/mcp/core/" in url:
        url, endpoint_id = url.rsplit("/mcp/core/", 1)
    elif "/mcp/" in url:
        url, endpoint_id = url.rsplit("/mcp/", 1)
    endpoint_id = os.environ.get("WEKNORA_AGENT_ENDPOINT_ID", "").strip() or endpoint_id
    return url.rstrip("/"), endpoint_id


def _response_status(result: dict) -> int:
    return 401 if result.get("http_status") == 401 or result.get("error_code") in {
        "UNAUTHORIZED", "USER_TOKEN_EXPIRED", "INVALID_USER_TOKEN", "USER_IDENTITY_REQUIRED"
    } else 200


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
    req = urllib.request.Request(f"{base}/mcp/core/{endpoint_id}", data=body, method="POST")
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
        # MCP may use SSE even for a single request; take its JSON-RPC frame.
        if raw.lstrip().startswith(("event:", "data:", ":")):
            frames = []
            for frame in raw.replace("\r\n", "\n").split("\n\n"):
                data = "\n".join(line[5:].lstrip() for line in frame.splitlines()
                                 if line.startswith("data:"))
                if data:
                    try:
                        candidate = json.loads(data)
                    except ValueError:
                        continue
                    if isinstance(candidate, dict) and candidate.get("id") == payload["id"]:
                        frames.append(data)
            raw = frames[-1] if frames else ""
        try:
            parsed = json.loads(raw)
        except Exception:  # noqa: BLE001
            return {"_http_status": status, "_body": raw[:500]}
        if not isinstance(parsed, dict):
            return {"_http_status": status, "_body": "invalid response"}
        parsed["_http_status"] = status
        return parsed

    try:
        rpc = await asyncio.to_thread(_do_call)
    except Exception as exc:  # upstream exceptions may embed request credentials
        log.warning("MCP transport failed (%s)", type(exc).__name__)
        return {"ok": False, "http_status": 502, "error": "MCP transport unavailable"}
    http_status = rpc.get("_http_status", 0)
    if "_body" in rpc and "result" not in rpc:
        return {"ok": False, "http_status": http_status,
                "error": f"MCP HTTP {http_status}",
                "error_code": "UNAUTHORIZED" if http_status == 401 else "MCP_HTTP_ERROR"}
    if "error" in rpc:
        err = rpc["error"] or {}
        return {"ok": False, "http_status": http_status,
                "error": "MCP protocol error", "error_code": "MCP_RPC_ERROR",
                "rpc_error": {"code": err.get("code")}}
    decoded = _decode_tool_result(_redact_payload(rpc.get("result") or {},
        [_endpoint_token(), user_headers.get("X-WeKnora-User-Token", "")]))
    out = {"ok": not decoded["is_error"], "http_status": http_status,
           "result": decoded["structured"], "text": decoded["text"]}
    if decoded["is_error"]:
        out["error"] = decoded["error_message"]
        out["error_code"] = decoded["error_code"]
    if _response_status(out) == 401:
        out["http_status"] = 401
    return out


def _redact_payload(value, secrets):
    if isinstance(value, dict):
        return {key: "[redacted]" if key.lower() in {
            "token", "access_token", "refresh_token", "password", "authorization",
            "x-weknora-user-token"} else _redact_payload(item, secrets)
            for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_payload(item, secrets) for item in value]
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[redacted]")
    return value


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


def _exception_auth_fields(exc: BaseException) -> dict:
    """Find SDK transport 401s through nested exception groups without dumping text."""
    pending, seen = [exc], set()
    while pending:
        item = pending.pop()
        if id(item) in seen:
            continue
        seen.add(id(item))
        status = getattr(item, "status_code", None) or getattr(item, "code", None)
        response = getattr(item, "response", None)
        if status == 401 or getattr(response, "status_code", None) == 401:
            return {"http_status": 401, "error_code": "UNAUTHORIZED"}
        pending.extend(getattr(item, "exceptions", ()) or ())
        pending.extend(child for child in (item.__cause__, item.__context__) if child)
    return {}


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
        log.warning("chat init failed (%s)", type(exc).__name__)
        yield {"data": json.dumps(
            {"type": "error", **_exception_auth_fields(exc),
             "message": f"初始化失败（{type(exc).__name__}）",
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
        log.warning("agent run failed (%s)", type(exc).__name__)
        yield {"data": json.dumps(
            {"type": "error", **_exception_auth_fields(exc),
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

async def _stream_ask(question: str, session_id: str, user_headers: dict[str, str],
                      mode: str = ""):
    """One direct `ask` MCP call streamed as SSE. This is the shape the
    main product will use when it wants WeKnora's own answer pipeline
    rather than letting its own model orchestrate the tools. `mode` selects
    WeKnora's native QA agent when the caller asked for one.
    """
    yield {"data": json.dumps(
        {"type": "status", "text": "正在调用 MCP ask 工具…"}, ensure_ascii=False)}
    arguments = {"question": question}
    if session_id:
        arguments["session_id"] = session_id
    if mode:
        arguments["mode"] = mode
    r = await _call_tool("ask", arguments, user_headers, timeout=ASK_TIMEOUT)
    if not r["ok"]:
        yield {"data": json.dumps(
            {"type": "error",
             "message": r.get("error") or r.get("error_message") or "ask 调用失败",
             "error_code": r.get("error_code"), "http_status": r.get("http_status")},
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
         "agent_id": data.get("agent_id") or "",
         "mode": data.get("mode") or "",
         "knowledge_base_ids": data.get("knowledge_base_ids") or []},
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
    mode = (body.get("mode") or "").strip()
    if not question:
        return JSONResponse({"error": "question is required"}, status_code=400)
    return EventSourceResponse(_stream_ask(question, session_id, user_headers, mode), ping=15)


# --- verification checklist (SSE) ------------------------------------------

def _kb_entry(result, kb_id: str) -> dict | None:
    for kb in (result or {}).get("knowledge_bases", []) or []:
        if str(kb.get("id")) == kb_id:
            return kb
    return None


def _literal_term(text: str) -> str:
    """First token of `text` that literal matching accepts as a term.

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


def _first_slug(node) -> str:
    """First non-empty "slug" value anywhere in a wiki index payload."""
    if isinstance(node, dict):
        value = node.get("slug")
        if isinstance(value, str) and value:
            return value
        for item in node.values():
            found = _first_slug(item)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = _first_slug(item)
            if found:
                return found
    return ""


def _wiki_hit_count(block) -> int:
    """Count wiki search hits: a page list when present, else the XML count."""
    if not isinstance(block, dict):
        return 0
    for key in ("pages", "results", "entries"):
        value = block.get(key)
        if isinstance(value, list):
            return len(value)
    content = block.get("content")
    if isinstance(content, str):
        match = re.search(r'count="(\d+)"', content)
        if match:
            return int(match.group(1))
        return content.count("<page>")
    return 0


def _document_hits(block) -> list:
    """The hit list of the aggregated document source."""
    if not isinstance(block, dict):
        return []
    value = block.get("results")
    return value if isinstance(value, list) else []


def _source_failure(payload, source: str) -> str:
    """The failure message of one source in an aggregated search payload."""
    if not isinstance(payload, dict):
        return ""
    if source not in (payload.get("failed_sources") or []):
        return ""
    for item in payload.get("failures") or []:
        if isinstance(item, dict) and item.get("source") == source:
            return str(item.get("error") or "")
    return "source failed"


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


async def _poll_ingest(ingest_id: str, document_id: str, headers: dict[str, str],
                       max_seconds: int = 150) -> dict:
    """Poll ingest_document.status until the parse leaves the running states.

    The aggregated status reports upload / parse / index separately; the
    parse phase is the one this poll waits on, and the document report is
    what the progress panel renders.
    """
    deadline = time.monotonic() + max_seconds
    last = {}
    while True:
        arguments = {"action": "status"}
        if ingest_id:
            arguments["ingest_id"] = ingest_id
        if document_id:
            arguments["document_id"] = document_id
        r = await _call_tool_retrying_rate_limit("ingest_document", arguments, headers)
        if not r["ok"]:
            return {"ok": False, "error": r.get("error"), "result": r.get("result"),
                    "http_status": r.get("http_status"), "error_code": r.get("error_code")}
        result = r.get("result") or {}
        last = result
        phases = result.get("phases") or {}
        parse = phases.get("parse") or "unknown"
        document = result.get("document") or {}
        if parse in ("completed", "failed", "cancelled"):
            return {"ok": parse == "completed", "result": result, "status": document,
                    "error": document.get("error_message") if parse != "completed" else None}
        if time.monotonic() >= deadline:
            return {"ok": False, "result": last, "status": document,
                    "error": f"解析超时（{max_seconds}s，最后状态 {parse}）"}
        await asyncio.sleep(CHECKLIST_POLL_INTERVAL)


async def _checklist_steps(kb_id: str, ingest_id: str, document_id: str,
                            user_headers: dict[str, str]):
    """Walk the FIVE core tools' read actions for one library + document.

    Each step is emitted as {"type":"step", tool, status, latency_ms,
    summary, raw}; the tool label is "tool.action" because the core surface
    aggregates several actions under one name. A step that cannot apply is
    "skip" WITH a reason, so a red row always means the tool failed, never
    "not configured".
    """
    # Narrow the request scope to the checklist's target KB: the
    # checklist is about exactly one KB, and an explicit selection is
    # what the plan's scope model expects from a client.
    headers = dict(user_headers)
    headers["X-WeKnora-Knowledge-Base-Ids"] = kb_id

    async def run_step(label: str, tool: str, action: str, arguments: dict,
                       timeout: int = CHECKLIST_STEP_TIMEOUT):
        started = time.monotonic()
        args = dict(arguments or {})
        if action:
            args["action"] = action
        r = await _call_tool_retrying_rate_limit(tool, args, headers, timeout=timeout)
        latency = round((time.monotonic() - started) * 1000)
        return r, latency

    def emit(tool, status, latency, summary, raw=None, *, result=None):
        return {"data": json.dumps(
            {"type": "step", "tool": tool, "status": status,
             "latency_ms": latency, "summary": summary, "raw": raw,
             **{key: result[key] for key in ("http_status", "error_code")
                if result is not None and result.get(key) is not None}},
            ensure_ascii=False)}

    summary = {"pass": 0, "fail": 0, "skip": 0}
    caps: dict = {}
    wiki_available = ""
    graph_available = ""

    # 1. knowledge_base.list — also reads the capability flags.
    r, latency = await run_step("knowledge_base.list", "knowledge_base", "list", {})
    kb = _kb_entry(r.get("result"), kb_id) if r["ok"] else None
    if not r["ok"]:
        summary["fail"] += 1
        yield emit("knowledge_base.list", "fail", latency,
                   r.get("error") or "调用失败", r.get("result"), result=r)
        yield {"data": json.dumps({"type": "done", "summary": summary}, ensure_ascii=False)}
        return
    if kb is None:
        summary["fail"] += 1
        yield emit("knowledge_base.list", "fail", latency,
                   f"知识库 {kb_id} 不在端点范围内", r.get("result"), result=r)
        yield {"data": json.dumps({"type": "done", "summary": summary}, ensure_ascii=False)}
        return
    caps = kb.get("capability_flags") or {}
    summary["pass"] += 1
    yield emit("knowledge_base.list", "pass", latency,
               f"{kb.get('name')} caps={','.join(k for k, v in caps.items() if v)}",
               kb)

    # 2. knowledge_base.get — status, parser catalogue and published profiles.
    r, latency = await run_step("knowledge_base.get", "knowledge_base", "get",
                                {"knowledge_base_id": kb_id})
    if r["ok"]:
        detail = (r.get("result") or {}).get("knowledge_base") or {}
        # knowledge_base.get wraps the legacy status payload, which itself
        # nests the counters under "status": detail.status.status.
        status_block = detail.get("status") or {}
        st = status_block.get("status") or status_block
        wiki_available = str(((st.get("wiki") or {}).get("available")) or "")
        graph_available = str(((st.get("graph") or {}).get("available")) or "")
        engines = (detail.get("parser_engines") or {}).get("engines") or []
        profiles = detail.get("qa_profiles") or []
        summary["pass"] += 1
        yield emit("knowledge_base.get", "pass", latency,
                   f"docs={st.get('documents')} chunks={st.get('chunks')} "
                   f"engines={len(engines)} wiki={wiki_available or 'n/a'} "
                   f"graph={graph_available or 'n/a'} profiles={len(profiles)}",
                   st)
    else:
        summary["fail"] += 1
        yield emit("knowledge_base.get", "fail", latency,
                   r.get("error"), r.get("result"), result=r)

    # Abort-early flag: a document that failed to parse makes the
    # read-side steps meaningless; they get skip("解析未完成") instead.
    parse_failed = False

    # 3. ingest_document.status — polls until the parse finishes.
    if ingest_id or document_id:
        started = time.monotonic()
        polled = await _poll_ingest(ingest_id, document_id, headers)
        latency = round((time.monotonic() - started) * 1000)
        phases = (polled.get("result") or {}).get("phases") or {}
        if polled["ok"]:
            summary["pass"] += 1
            yield emit("ingest_document.status", "pass", latency,
                       f"phases={json.dumps(phases, ensure_ascii=False)}",
                       polled.get("result"))
        else:
            parse_failed = True
            summary["fail"] += 1
            yield emit("ingest_document.status", "fail", latency,
                       polled.get("error") or "解析未完成", polled.get("result"), result=polled)
    else:
        parse_failed = True
        summary["skip"] += 1
        yield emit("ingest_document.status", "skip", 0, "本次流程没有 ingest_id / document_id")

    title = ""
    read_result = {}

    # 4. read_document.read — the document text behind the citations.
    if document_id and not parse_failed:
        r, latency = await run_step("read_document.read", "read_document", "read",
                                    {"knowledge_id": document_id, "limit": 2})
        if r["ok"]:
            read_result = (r.get("result") or {}).get("document") or {}
            meta = read_result.get("document") or {}
            title = str(meta.get("title") or read_result.get("title") or "")
            chunks = read_result.get("chunks") or []
            summary["pass"] += 1
            yield emit("read_document.read", "pass", latency,
                       f"chunks≤2 ({len(chunks)}) total={read_result.get('total_chunks')} "
                       f"truncated={read_result.get('truncated')}",
                       read_result)
        else:
            summary["fail"] += 1
            yield emit("read_document.read", "fail", latency,
                       r.get("error"), r.get("result"), result=r)
    else:
        summary["skip"] += 1
        yield emit("read_document.read", "skip", 0, "解析未完成，跳过")

    # 5. read_document.list — the library catalogue (also the title fallback
    # when the checklist was started without a document id).
    if not parse_failed:
        r, latency = await run_step("read_document.list", "read_document", "list",
                                    {"knowledge_base_id": kb_id, "page_size": 5})
        if r["ok"]:
            block = (r.get("result") or {}).get("documents") or {}
            docs = block.get("documents") or []
            if not title and docs:
                newest = next((d for d in docs if d.get("parse_status") == "completed"),
                              docs[0])
                title = str(newest.get("title") or newest.get("file_name") or "")
            summary["pass"] += 1
            yield emit("read_document.list", "pass", latency,
                       f"total={block.get('total')}", block)
        else:
            summary["fail"] += 1
            yield emit("read_document.list", "fail", latency,
                       r.get("error"), r.get("result"), result=r)
    else:
        summary["skip"] += 1
        yield emit("read_document.list", "skip", 0, "解析未完成，跳过")

    # 6/7. search_knowledge: ranked and literal document search, gated on
    # the library's vector/keyword capabilities.
    retrievable = bool(caps.get("vector") or caps.get("keyword"))
    for label, match in (("search_knowledge.document", ""),
                         ("search_knowledge.literal", "literal")):
        if parse_failed:
            summary["skip"] += 1
            yield emit(label, "skip", 0, "解析未完成，跳过")
            continue
        if not retrievable:
            summary["skip"] += 1
            yield emit(label, "skip", 0, "该知识库未启用向量/关键词检索")
            continue
        query = _literal_term(title or "document") if match else (title or "document")
        arguments = {"query": query, "knowledge_base_ids": [kb_id], "limit": 3}
        if match:
            arguments["match"] = "literal"
        r, latency = await run_step(label, "search_knowledge", "", arguments)
        block = ((r.get("result") or {}).get("results") or {}).get("document") or {}
        hits = _document_hits(block)
        failure = _source_failure(r.get("result"), "document")
        if r["ok"] and not failure:
            summary["pass"] += 1
            yield emit(label, "pass", latency, f"hits={len(hits)} query={query!r}",
                       r.get("result"), result=r)
        else:
            summary["fail"] += 1
            yield emit(label, "fail", latency, failure or r.get("error"),
                       r.get("result"), result=r)

    # 8-9. Wiki: two-tier gate — capability flag, then runtime availability
    # from the KB status (enabled but nothing generated is a skip, not a
    # failure). The core read actions browse the wiki catalogue and one page.
    wiki_gate = ""
    if not caps.get("wiki"):
        wiki_gate = "该知识库未启用 Wiki"
    elif wiki_available == "unavailable":
        wiki_gate = "Wiki 已启用但当前不可用（尚未生成或生成失败）"
    wiki_slug = ""
    if wiki_gate:
        summary["skip"] += 1
        yield emit("read_document.list(wiki)", "skip", 0, wiki_gate)
    else:
        r, latency = await run_step("read_document.list(wiki)", "read_document", "list",
                                    {"knowledge_base_id": kb_id, "source_type": "wiki"})
        if r["ok"]:
            block = (r.get("result") or {}).get("wiki") or {}
            wiki_slug = _first_slug(block)
            summary["pass"] += 1
            yield emit("read_document.list(wiki)", "pass", latency,
                       f"groups={len(block.get('groups') or [])} slug={wiki_slug or '（无）'}",
                       block)
        else:
            summary["fail"] += 1
            yield emit("read_document.list(wiki)", "fail", latency,
                       r.get("error"), r.get("result"), result=r)
    if wiki_gate:
        summary["skip"] += 1
        yield emit("read_document.read(wiki)", "skip", 0, wiki_gate)
    elif not wiki_slug:
        summary["skip"] += 1
        yield emit("read_document.read(wiki)", "skip", 0, "Wiki 目录里没有可读的 slug")
    else:
        r, latency = await run_step("read_document.read(wiki)", "read_document", "read",
                                    {"source_type": "wiki", "slug": wiki_slug,
                                     "knowledge_base_id": kb_id})
        if r["ok"]:
            page = (r.get("result") or {}).get("page") or {}
            refs = page.get("source_refs_v2") or {}
            summary["pass"] += 1
            yield emit("read_document.read(wiki)", "pass", latency,
                       f"slug={wiki_slug} refs={len(refs)}", page)
        else:
            summary["fail"] += 1
            yield emit("read_document.read(wiki)", "fail", latency,
                       r.get("error"), r.get("result"), result=r)

    # 10. search_knowledge(wiki)
    if wiki_gate:
        summary["skip"] += 1
        yield emit("search_knowledge.wiki", "skip", 0, wiki_gate)
    else:
        r, latency = await run_step("search_knowledge.wiki", "search_knowledge", "",
                                    {"query": title or "总结", "knowledge_base_ids": [kb_id],
                                     "sources": ["wiki"], "limit": 5})
        block = ((r.get("result") or {}).get("results") or {}).get("wiki") or {}
        failure = _source_failure(r.get("result"), "wiki")
        if r["ok"] and not failure:
            summary["pass"] += 1
            yield emit("search_knowledge.wiki", "pass", latency,
                       f"hits={_wiki_hit_count(block)}", block)
        else:
            summary["fail"] += 1
            yield emit("search_knowledge.wiki", "fail", latency,
                       failure or r.get("error"), r.get("result"), result=r)

    # 11. search_knowledge(graph) — capability flag + runtime availability.
    if not caps.get("graph"):
        summary["skip"] += 1
        yield emit("search_knowledge.graph", "skip", 0, "该知识库未启用图谱抽取")
    elif graph_available == "unavailable":
        summary["skip"] += 1
        yield emit("search_knowledge.graph", "skip", 0,
                   "图谱已启用但当前不可用（尚未抽取或图存储不可达）")
    else:
        query = _literal_term(title or "entity")
        r, latency = await run_step("search_knowledge.graph", "search_knowledge", "",
                                    {"query": query, "knowledge_base_ids": [kb_id],
                                     "sources": ["graph"]})
        block = ((r.get("result") or {}).get("results") or {}).get("graph") or {}
        failure = _source_failure(r.get("result"), "graph")
        relations = block.get("relations") or []
        if r["ok"] and not failure:
            summary["pass"] += 1
            yield emit("search_knowledge.graph", "pass", latency,
                       f"relations={len(relations)} query={query!r}", block)
        elif "GRAPH_EXTRACTION_NOT_CONFIGURED" in failure or "GRAPH_UNAVAILABLE" in failure:
            # Config state, not a tool defect: report as skip with reason.
            summary["skip"] += 1
            yield emit("search_knowledge.graph", "skip", latency,
                       f"配置态：{failure}", r.get("result"), result=r)
        else:
            summary["fail"] += 1
            yield emit("search_knowledge.graph", "fail", latency,
                       failure or r.get("error"), r.get("result"), result=r)

    yield {"data": json.dumps({"type": "done", "summary": summary}, ensure_ascii=False)}


async def _checklist_stream(kb_id: str, ingest_id: str, document_id: str,
                            user_headers: dict[str, str]):
    """Stop the checklist at the first rejected identity and expose its SSE status."""
    summary = {"pass": 0, "fail": 0, "skip": 0}
    steps = _checklist_steps(kb_id, ingest_id, document_id, user_headers)
    try:
        async for frame in steps:
            event = json.loads(frame["data"])
            if event.get("type") == "step":
                summary[event["status"]] += 1
            yield frame
            if _response_status(event) == 401:
                yield {"data": json.dumps({"type": "error", "http_status": 401,
                    "error_code": "UNAUTHORIZED", "message": "MCP user identity rejected"})}
                yield {"data": json.dumps({"type": "done", "summary": summary})}
                return
    finally:
        await steps.aclose()


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
    ingest_id = (body.get("ingest_id") or "").strip()
    document_id = (body.get("document_id") or "").strip()
    return EventSourceResponse(
        _checklist_stream(kb_id, ingest_id, document_id, user_headers), ping=15)


# --- explicit core tool calls (ingest, status, generic runner) -------------

async def ingest(request: Request):
    """Forward one upload+import as a single ingest_document.submit call.

    The core contract is JSON: the bytes travel base64 inside the tool call,
    which stages them, persists the idempotency receipt, imports and enqueues
    in one step. The console keeps its file-picker form, so this route reads
    the multipart form, base64-encodes the bytes and forwards one tool call.
    The Idempotency-Key header maps to the tool's idempotency_key; the form's
    process_config (parser engine rules) is forwarded unchanged.
    """
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
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

    arguments = {
        "action": "submit",
        "knowledge_base_id": kb_id,
        "file": {
            "name": file_field.filename,
            "encoding": "base64",
            "content": base64.b64encode(raw).decode("ascii"),
        },
    }
    idem = (request.headers.get("Idempotency-Key")
            or request.query_params.get("idempotency_key") or "").strip()
    if idem:
        arguments["idempotency_key"] = idem
    process_config_raw = (form.get("process_config") or "").strip()
    if process_config_raw:
        try:
            process_config = json.loads(process_config_raw)
        except json.JSONDecodeError:
            return JSONResponse({"error": "process_config must be JSON"}, status_code=400)
        if isinstance(process_config, dict) and process_config:
            arguments["process_config"] = process_config
    log.info("ingest_document.submit receive: name=%s size=%d", file_field.filename, len(raw))
    r = await _call_tool("ingest_document", arguments, user_headers, timeout=300)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error"), "result": r.get("result"),
                             "error_code": r.get("error_code")}, status_code=_response_status(r))
    return JSONResponse({"ok": True, "result": r.get("result")})


async def ingest_status(request: Request):
    """ingest_document.status: upload, parse, index, wiki and graph phases."""
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    ingest_id = (request.query_params.get("ingest_id") or "").strip()
    document_id = (request.query_params.get("document_id") or "").strip()
    if not ingest_id and not document_id:
        return JSONResponse({"error": "ingest_id or document_id is required"}, status_code=400)
    arguments = {"action": "status"}
    if ingest_id:
        arguments["ingest_id"] = ingest_id
    if document_id:
        arguments["document_id"] = document_id
    r = await _call_tool("ingest_document", arguments, user_headers)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error"),
                             "error_code": r.get("error_code"), "result": r.get("result")},
                            status_code=_response_status(r))
    return JSONResponse({"ok": True, "result": r.get("result")})


async def kb_status(request: Request):
    """knowledge_base.get: one library's status, catalogue and profiles."""
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    kb_id = (request.query_params.get("knowledge_base_id") or "").strip()
    if not kb_id:
        return JSONResponse({"error": "knowledge_base_id is required"}, status_code=400)
    r = await _call_tool("knowledge_base",
                         {"action": "get", "knowledge_base_id": kb_id}, user_headers)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error"),
                             "error_code": r.get("error_code"), "result": r.get("result")},
                            status_code=_response_status(r))
    return JSONResponse({"ok": True, "result": r.get("result")})


def _int_query(request: Request, name: str, default: int,
               minimum: int = 1, maximum: int = 100) -> int:
    """Read a bounded integer query parameter without rejecting the request.

    MCP clamps the same fields again, so a malformed value may safely fall
    back to the page's default instead of turning into a 500 here.
    """
    raw = (request.query_params.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


async def documents(request: Request):
    """read_document.list: one library's document catalogue.

    The core tool wraps its result as `documents: {total, page, ...}`; the
    console lifts those fields to the top level so the page can render a
    pager without knowing the core envelope.
    """
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    kb_id = (request.query_params.get("knowledge_base_id") or "").strip()
    if not kb_id:
        return JSONResponse({"error": "knowledge_base_id is required"}, status_code=400)
    page = _int_query(request, "page", 1)
    page_size = _int_query(request, "page_size", 10)
    r = await _call_tool("read_document", {
        "action": "list", "knowledge_base_id": kb_id,
        "page": page, "page_size": page_size,
    }, user_headers)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error"),
                             "error_code": r.get("error_code"), "result": r.get("result")},
                            status_code=_response_status(r))
    block = (r.get("result") or {}).get("documents") or {}
    return JSONResponse({
        "ok": True,
        "knowledge_base_id": block.get("knowledge_base_id") or kb_id,
        "total": block.get("total") or 0,
        "page": block.get("page") or page,
        "page_size": block.get("page_size") or page_size,
        "documents": block.get("documents") or [],
    })


async def document(request: Request):
    """read_document.read: one document's metadata and a page of chunks.

    `query` switches the core tool to in-document literal search, which
    returns matched chunks with one chunk of context on each side; `offset`
    continues from the returned `next_offset`.
    """
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    doc_id = (request.query_params.get("knowledge_id") or "").strip()
    if not doc_id:
        return JSONResponse({"error": "knowledge_id is required"}, status_code=400)
    offset = _int_query(request, "offset", 0, minimum=0, maximum=1_000_000)
    limit = _int_query(request, "limit", 10)
    arguments = {"action": "read", "knowledge_id": doc_id,
                 "offset": offset, "limit": limit}
    query = (request.query_params.get("query") or "").strip()
    if query:
        arguments["query"] = query
    r = await _call_tool("read_document", arguments, user_headers)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error"),
                             "error_code": r.get("error_code"), "result": r.get("result")},
                            status_code=_response_status(r))
    data = (r.get("result") or {}).get("document") or {}
    return JSONResponse({
        "ok": True,
        "knowledge_base_id": data.get("knowledge_base_id") or "",
        "document": data.get("document") or {},
        "chunks": data.get("chunks") or [],
        "total_chunks": data.get("total_chunks") or 0,
        "fetched_chunks": data.get("fetched_chunks") or 0,
        "offset": data.get("offset", offset),
        "page_size": data.get("page_size", limit),
        "query": data.get("query") or "",
        "match_count": data.get("match_count"),
        "truncated": bool(data.get("truncated")),
        "next_offset": data.get("next_offset"),
    })


async def parser_engines(request: Request):
    """Parser catalogue through knowledge_base.get(include_capabilities).

    The catalogue is deployment-wide; the library supplies the caller's
    authorization. Without an explicit library the first visible one is used.
    Endpoints without get_knowledge_base_status + list_parser_engines answer
    ok=false and the page falls back to the knowledge base default.
    """
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    kb_id = (request.query_params.get("knowledge_base_id") or "").strip()
    if not kb_id:
        listing = await _call_tool("knowledge_base", {"action": "list"}, user_headers)
        if not listing["ok"]:
            return JSONResponse({"ok": False, "error": listing.get("error"),
                                 "error_code": listing.get("error_code"),
                                 "http_status": listing.get("http_status")},
                                status_code=_response_status(listing))
        kbs = (listing.get("result") or {}).get("knowledge_bases") or []
        kb_id = str((kbs[0] or {}).get("id") or "") if kbs else ""
        if not kb_id:
            return JSONResponse({"ok": False,
                                 "error": "当前身份没有可见的知识库，无法读取解析引擎目录"})
    r = await _call_tool("knowledge_base", {
        "action": "get", "knowledge_base_id": kb_id, "include_capabilities": True,
    }, user_headers)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error"),
                             "error_code": r.get("error_code"),
                             "http_status": r.get("http_status")},
                            status_code=_response_status(r))
    detail = (r.get("result") or {}).get("knowledge_base") or {}
    catalog = detail.get("parser_engines")
    if not isinstance(catalog, dict):
        return JSONResponse({"ok": False,
                             "error": "该端点未开放解析引擎目录（knowledge_base.get 需要 "
                                      "get_knowledge_base_status + list_parser_engines 权限）",
                             "http_status": r.get("http_status")})
    return JSONResponse({"ok": True, "result": catalog})


async def kbs(request: Request):
    """knowledge_base.list: what can this caller see, and which capabilities
    does each KB have. Drives the KB selector and the capability gating in
    the checklist.
    """
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    r = await _call_tool("knowledge_base", {"action": "list"}, user_headers)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error"),
                             "error_code": r.get("error_code"), "http_status": r.get("http_status")}, status_code=_response_status(r))
    return JSONResponse({"ok": True, "result": r.get("result")})


async def tools(request: Request):
    """tools/list through MCP, with the console's destructive badge."""
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    r = await _mcp_rpc("tools/list", {}, user_headers)
    if not r["ok"]:
        return JSONResponse({"ok": False, "error": r.get("error"), "error_code": r.get("error_code")}, status_code=_response_status(r))
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
    }, status_code=_response_status(r))


async def endpoint_info(request: Request):
    """Safe local endpoint facts plus the caller's actual MCP tool catalog."""
    user_headers = _extract_mcp_headers(request)
    if user_headers is None:
        return _missing_header_response()
    base, endpoint_id = _mcp_endpoint_target()
    result = await _mcp_rpc("tools/list", {}, user_headers)
    if not result["ok"]:
        return JSONResponse(result, status_code=_response_status(result))
    listed = (result.get("result") or {}).get("tools") or []
    return JSONResponse({"ok": True, "endpoint_id": endpoint_id,
        "name": os.environ.get("WEKNORA_AGENT_ENDPOINT_NAME", endpoint_id),
        "mcp_url": f"{base}/mcp/core/{endpoint_id}",
        "surface": "core",
        "tools": [item["name"] for item in listed if isinstance(item, dict) and item.get("name")]})


# --- local credential file (demo convenience, explicitly opted in) ----------

# The workbench does not log in and never sees a password. Credentials are
# issued by the standalone WeKnora utility (issue_user_token.py), which writes
# one JSON file; this endpoint only *reads* that file so the page can offer a
# one-click "读取本机凭证" instead of pasting a JWT by hand. The file stays the
# single source of truth and is never modified here.
#
# The convenience is an explicit opt-in: without WEKNORA_CREDENTIAL_FILE the
# endpoint reports "not configured" and there is NO default sibling-repo path,
# so a copied Agent checkout cannot silently read another checkout's JWT.
# Responses are same-machine only (Host check), not cacheable, and never
# include the file path.
CREDENTIAL_FILE_ENV = "WEKNORA_CREDENTIAL_FILE"

_NO_STORE = {"Cache-Control": "no-store"}
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}


def _local_credential_path() -> Path | None:
    configured = os.environ.get(CREDENTIAL_FILE_ENV, "").strip()
    if configured:
        return Path(configured).expanduser()
    return None


def _same_machine_host(authority: str) -> bool:
    host = (authority or "").split(":", 1)[0].strip("[]").lower()
    return host in _LOCAL_HOSTS


async def local_credential(request: Request):
    path = _local_credential_path()
    if path is None:
        return JSONResponse({
            "available": False,
            "hint": "本机凭证读取未启用：设置 WEKNORA_CREDENTIAL_FILE 指向签发工具的输出文件。",
        }, status_code=404, headers=_NO_STORE)
    # Same-machine gate: a page served from another origin must not be able to
    # read this machine's JWT, even though binding to 127.0.0.1 already limits
    # who can connect.
    host = (request.headers.get("host") or "").split(":", 1)[0].strip("[]").lower()
    if host not in _LOCAL_HOSTS:
        return JSONResponse({"available": False,
                             "hint": "本机凭证读取仅限 127.0.0.1 / localhost 访问"},
                            status_code=403, headers=_NO_STORE)
    origin = request.headers.get("origin") or ""
    if origin:
        origin_host = urllib.parse.urlsplit(origin).hostname or ""
        if origin_host not in _LOCAL_HOSTS:
            return JSONResponse({"available": False,
                                 "hint": "来源不是本机页面"},
                                status_code=403, headers=_NO_STORE)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return JSONResponse({
            "available": False,
            "hint": "还没有本机凭证文件。先在终端运行一次 scripts/refresh-credential.ps1，再点这里读取。",
        }, headers=_NO_STORE)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"available": False,
                             "hint": f"凭证文件无法读取：{type(exc).__name__}"}, headers=_NO_STORE)
    token = str(payload.get("token") or "").strip()
    if not token:
        return JSONResponse({"available": False, "hint": "凭证文件里没有 Token，请重新生成。"},
                            headers=_NO_STORE)
    response = JSONResponse({
        "available": True,
        "credential": {
            "token": token,
            "expires_at": payload.get("expires_at") or "",
            "profile": payload.get("profile") or {},
        },
    })
    response.headers["Cache-Control"] = "no-store"
    return response


# --- page metadata + index + healthz ---------------------------------------

async def info(request: Request):
    kbs_env = [k for k in os.environ.get("WEKNORA_KB_IDS", "").split(",") if k.strip()]
    _, endpoint_id = _mcp_endpoint_target()
    return JSONResponse({
        "model": os.environ.get("AGENT_MODEL", ""),
        "mcp_url": os.environ.get("WEKNORA_MCP_URL", ""),
        "endpoint_id": endpoint_id,
        "knowledge_bases": len(kbs_env),
        "default_email": "15918868657@163.com",
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
        Route("/api/local-credential", local_credential),
        Route("/api/kbs", kbs),
        Route("/api/parser-engines", parser_engines),
        Route("/api/tools", tools),
        Route("/api/tool", run_tool, methods=["POST"]),
        Route("/api/endpoint", endpoint_info),
        Route("/api/checklist", checklist, methods=["POST"]),
        Route("/api/ask", ask, methods=["POST"]),
        Route("/api/chat", chat, methods=["POST"]),
        Route("/api/ingest", ingest, methods=["POST"]),
        Route("/api/ingest_status", ingest_status),
        Route("/api/kb_status", kb_status),
        Route("/api/documents", documents),
        Route("/api/document", document),
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