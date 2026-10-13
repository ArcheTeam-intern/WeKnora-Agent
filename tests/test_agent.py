import importlib
import importlib.util
import json
import sys
import asyncio
import subprocess
from pathlib import Path

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, ToolMessage


def module(name):
    assert importlib.util.find_spec(name) is not None, f"缺少纯 Agent 模块 {name}"
    return importlib.import_module(name)


def test_config_expands_env_without_changing_native_sdk_shape(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_MCP_TOKEN", 'secret"with\\characters')
    config = {"weknora": {"transport": "streamable_http", "url": "http://localhost/mcp/demo",
                          "headers": {"Authorization": "Bearer ${TEST_MCP_TOKEN}"}}}
    path = tmp_path / "mcp.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    actual = module("main").load_connections(path)
    assert actual["weknora"]["headers"]["Authorization"] == 'Bearer secret"with\\characters'
    assert actual["weknora"]["transport"] == "streamable_http"
    assert json.loads(path.read_text(encoding="utf-8")) == config


def test_missing_env_fails_before_connecting(tmp_path, monkeypatch):
    monkeypatch.delenv("MISSING_MCP_TOKEN", raising=False)
    path = tmp_path / "mcp.json"
    path.write_text('{"weknora":{"url":"${MISSING_MCP_TOKEN}"}}', encoding="utf-8")
    with pytest.raises(ValueError, match="MISSING_MCP_TOKEN"):
        module("main").load_connections(path)


def test_cli_missing_config_returns_nonzero_without_a_traceback(tmp_path):
    completed = subprocess.run([sys.executable, "main.py", "--question", "测试",
                                "--mcp-config", str(tmp_path / "missing.json")],
                               cwd=Path(__file__).resolve().parents[1],
                               capture_output=True, text=True, encoding="utf-8",
                               env={**__import__("os").environ, "PYTHONUTF8": "1"})
    assert completed.returncode == 1
    assert "配置错误" in completed.stderr
    assert "Traceback" not in completed.stderr


@pytest.mark.asyncio
async def test_run_has_a_deadline_for_tool_discovery(monkeypatch):
    async def stalled_discovery(*args):
        await asyncio.sleep(10)

    monkeypatch.setattr(module("main"), "build_agent", stalled_discovery)
    with pytest.raises(TimeoutError):
        await module("main").run("问题", None, {}, timeout=0.01)


class ScriptedModel(FakeMessagesListChatModel):
    # Network-free model fixture. Production uses the provider's standard model.
    def bind_tools(self, tools, **kwargs):
        return self


@pytest.mark.asyncio
async def test_standard_agent_calls_document_wiki_and_graph_via_real_mcp():
    calls = [
        {"name": "search_knowledge", "args": {"query": "负责人"}, "id": "search-1", "type": "tool_call"},
        {"name": "wiki_read_page", "args": {"slug": "project"}, "id": "wiki-1", "type": "tool_call"},
        {"name": "query_knowledge_graph", "args": {"query": "项目关系"}, "id": "graph-1", "type": "tool_call"},
    ]
    model = ScriptedModel(responses=[AIMessage(content="", tool_calls=calls),
                                    AIMessage(content="负责人张三。[document:doc-1][wiki:project][relation:rel-1]")])
    connections = {"weknora": {"transport": "stdio", "command": sys.executable,
                               "args": [str(Path(__file__).with_name("mcp_fixture.py"))]}}
    agent = await module("agent").build_agent(model, connections)
    result = await agent.ainvoke({"messages": [{"role": "user", "content": "谁负责，相关关系是什么？"}]},
                                config={"recursion_limit": 10})
    outputs = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert {m.name for m in outputs} == {c["name"] for c in calls}
    assert all(m.status == "success" for m in outputs)
    assert "doc-1" in str(outputs[0:])
    assert "relation:rel-1" in result["messages"][-1].content


@pytest.mark.asyncio
async def test_write_tool_is_not_available_to_model():
    model = ScriptedModel(responses=[
        AIMessage(content="", tool_calls=[{"name": "import_document_file", "args": {},
                                            "id": "write-1", "type": "tool_call"}]),
        AIMessage(content="写入工具不可用。"),
    ])
    connections = {"weknora": {"transport": "stdio", "command": sys.executable,
                               "args": [str(Path(__file__).with_name("mcp_fixture.py"))]}}
    agent = await module("agent").build_agent(model, connections)
    result = await agent.ainvoke({"messages": [{"role": "user", "content": "导入资料"}]})
    outputs = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert len(outputs) == 1
    assert outputs[0].status == "error"
    assert "not a valid tool" in str(outputs[0].content)


@pytest.mark.asyncio
async def test_mcp_tool_failure_is_visible():
    model = ScriptedModel(responses=[
        AIMessage(content="", tool_calls=[{"name": "read_document", "args": {"document_id": "denied"},
                                            "id": "read-1", "type": "tool_call"}]),
        AIMessage(content="读取失败，无法据此回答。"),
    ])
    connections = {"weknora": {"transport": "stdio", "command": sys.executable,
                               "args": [str(Path(__file__).with_name("mcp_fixture.py"))]}}
    agent = await module("agent").build_agent(model, connections)
    result = await agent.ainvoke({"messages": [{"role": "user", "content": "读取资料"}]})
    output = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert output.status == "error"
    assert "permission denied" in str(output.content)
