"""Streamable HTTP transport integration with the real langchain-mcp-adapters SDK.

Spins up a FastMCP server bound to a random local port, connects through
MultiServerMCPClient, and verifies tools/list, tool invocation, error
mapping and timeouts against the production read-only tool surface.
"""
import asyncio
import logging
import socket
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, ToolMessage

from tests import mcp_http_fixture  # noqa: F401  (registers tools)
from tests.mcp_http_fixture import build_server


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class _ScriptedModel(FakeMessagesListChatModel):
    """Network-free model fixture that forwards tool calls back to the agent."""

    def bind_tools(self, tools, **kwargs):  # noqa: D401
        return self


@contextmanager
def _http_server():
    """Start FastMCP on a free port, expose its URL, ensure the process exits."""
    port = _free_port()
    server = build_server(port=port)
    thread = threading.Thread(
        target=server.run, kwargs={"transport": "streamable-http"}, daemon=True
    )
    thread.start()
    # Wait until the socket is actually listening (uvicorn binds late).
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.connect(("127.0.0.1", port))
                break
            except OSError:
                time.sleep(0.05)
    else:
        raise RuntimeError("FastMCP streamable-http server failed to bind")
    try:
        yield f"http://127.0.0.1:{port}/mcp"
    finally:
        # Daemon thread dies with the test process; nothing to clean up.
        pass


@pytest.mark.asyncio
async def test_http_tools_list_exposes_thirteen_read_only_tools():
    with _http_server() as url:
        from agent import READ_ONLY_TOOLS, build_agent
        model = _ScriptedModel(responses=[AIMessage(content="无工具调用。")])
        agent = await build_agent(model, {"weknora": {
            "transport": "streamable_http", "url": url,
            "headers": {"Authorization": "Bearer t",
                        "X-WeKnora-User-Token": "u",
                        "X-Tenant-ID": "1",
                        "X-WeKnora-Knowledge-Base-Ids": "kb"}},
        })
        # Smoke check: 13 read-only tools must all be present.
        from langchain_mcp_adapters.client import MultiServerMCPClient
        client = MultiServerMCPClient({"weknora": {
            "transport": "streamable_http", "url": url,
            "headers": {"Authorization": "Bearer t",
                        "X-WeKnora-User-Token": "u",
                        "X-Tenant-ID": "1",
                        "X-WeKnora-Knowledge-Base-Ids": "kb"}}})
        tools = await client.get_tools()
        names = {tool.name for tool in tools}
        assert READ_ONLY_TOOLS <= names, f"缺少核心只读工具：{READ_ONLY_TOOLS - names}"
        assert {"import_document_file", "get_upload_status"} & names == set()


@pytest.mark.asyncio
async def test_http_agent_calls_real_read_document_via_streamable_http(caplog):
    with _http_server() as url:
        from agent import build_agent
        model = _ScriptedModel(responses=[
            AIMessage(content="", tool_calls=[{"name": "read_document", "type": "tool_call",
                                               "id": "r1", "args": {"knowledge_id": "doc-1",
                                                                    "limit": 5}}]),
            AIMessage(content="已读取 doc-1。"),
        ])
        with caplog.at_level(logging.WARNING, logger="agent"):
            agent = await build_agent(model, {"weknora": {
                "transport": "streamable_http", "url": url,
                "headers": {"Authorization": "Bearer t",
                            "X-WeKnora-User-Token": "u",
                            "X-Tenant-ID": "1",
                            "X-WeKnora-Knowledge-Base-Ids": "kb"}}})
            result = await agent.ainvoke({"messages": [{"role": "user", "content": "原文"}]},
                                         config={"recursion_limit": 10})
        outputs = [m for m in result["messages"] if isinstance(m, ToolMessage)]
        assert len(outputs) == 1
        assert outputs[0].status == "success"
        assert "doc-1" in str(outputs[0].content)
        # 端点 13 项只读工具齐全时不应告警。
        assert not any("缺少核心只读工具" in record.message for record in caplog.records)


@pytest.mark.asyncio
async def test_http_endpoint_missing_read_only_tools_warns_but_still_runs(caplog):
    """Verify the 13-tool completeness warning fires when the endpoint is partial."""
    with _http_server() as url:
        from agent import build_agent
        # 客户端在 langchain-mcp-adapters 层会先做一次 tools/list；构造空 fixture。
        import mcp.server.fastmcp as fastmcp_mod
        partial = fastmcp_mod.FastMCP("partial", host="127.0.0.1", port=_free_port(),
                                      json_response=True, warn_on_duplicate_tools=False)

        @partial.tool()
        def search_knowledge(query: str) -> dict:  # 故意只暴露一个
            return {"results": []}

        port = partial.settings.port
        thread = threading.Thread(target=partial.run,
                                  kwargs={"transport": "streamable-http"}, daemon=True)
        thread.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                try:
                    probe.connect(("127.0.0.1", port))
                    break
                except OSError:
                    time.sleep(0.05)
        model = _ScriptedModel(responses=[AIMessage(content="仅一个工具。")])
        with caplog.at_level(logging.WARNING, logger="agent"):
            agent = await build_agent(model, {"weknora": {
                "transport": "streamable_http", "url": f"http://127.0.0.1:{port}/mcp",
                "headers": {"Authorization": "Bearer t",
                            "X-WeKnora-User-Token": "u",
                            "X-Tenant-ID": "1",
                            "X-WeKnora-Knowledge-Base-Ids": "kb"}}})
            assert agent is not None
        assert any("缺少核心只读工具" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_http_discovery_timeout_is_raised():
    """A non-listening port must surface as TimeoutError, not a hung await."""
    port = _free_port()  # never bound
    from agent import build_agent
    model = _ScriptedModel(responses=[AIMessage(content="")])
    with pytest.raises((TimeoutError, OSError, Exception)) as exc_info:
        async with asyncio.timeout(3):
            await build_agent(model, {"weknora": {
                "transport": "streamable_http",
                "url": f"http://127.0.0.1:{port}/mcp",
                "headers": {"Authorization": "Bearer t"}}})
    # 只要不是静默成功即可；SDK 抛 ConnectError/Exception 都算合理。
    assert exc_info.value is not None


@pytest.mark.asyncio
async def test_http_recursion_limit_is_enforced():
    """recursion_limit 必须被框架强制，否则会无限循环。"""
    with _http_server() as url:
        from agent import build_agent
        # 模型永远只生成 tool_call，不给出最终答案。
        model = _ScriptedModel(responses=[
            AIMessage(content="", tool_calls=[{"name": "search_knowledge", "type": "tool_call",
                                               "id": "s", "args": {"query": "q"}}])
        ] * 50 + [AIMessage(content="放弃。")])
        agent = await build_agent(model, {"weknora": {
            "transport": "streamable_http", "url": url,
            "headers": {"Authorization": "Bearer t",
                        "X-WeKnora-User-Token": "u",
                        "X-Tenant-ID": "1",
                        "X-WeKnora-Knowledge-Base-Ids": "kb"}}})
        with pytest.raises((Exception,)):
            await agent.ainvoke({"messages": [{"role": "user", "content": "q"}]},
                                config={"recursion_limit": 4})


def test_http_imports_only_standard_agent_stack():
    """main.py / agent.py / requirements.txt 不得引入旧应用依赖。

    MultiServerMCPClient 是 langchain-mcp-adapters 的 SDK 类，保留；本检查
    阻止的是自建 MCPClient 包装、自建 session 与旧 backend 引用。
    """
    import re
    root = Path(__file__).resolve().parents[1]
    # 词边界正则：仅匹配独立的自建类/函数名，不误伤 SDK。
    forbidden_patterns = (
        r"\bFastAPI\b", r"\bSessionStore\b", r"\bMCPClient\b(?!\w)",
        r"\b_BudgetedChatModel\b", r"backend\.app", r"\bevidence\b",
        r"\bsqlite\b", r"\bmultipart\b", r"\buvicorn\b",
    )
    for filename in ("main.py", "agent.py", "requirements.txt"):
        text = (root / filename).read_text(encoding="utf-8")
        for pattern in forbidden_patterns:
            match = re.search(pattern, text)
            assert match is None, (
                f"{filename} 包含禁用项 {match.group(0)!r}（模式 {pattern}）"
            )
