"""CLI configuration and invocation; all knowledge business stays in WeKnora."""
import argparse
import asyncio
import json
import os
import re
from pathlib import Path

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI

from agent import build_agent, core_connections


class ConfigurationError(ValueError):
    pass


def required_env(name):
    value = os.environ.get(name)
    if not value or not value.strip():
        raise ConfigurationError(f"缺少环境变量：{name}")
    return value


def load_connections(path, *, header_overrides=None):
    # Expand parsed string values, not raw JSON, so quotes/backslashes stay safe.
    def expand(value):
        if isinstance(value, str):
            return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}",
                          lambda match: required_env(match[1]), value)
        if isinstance(value, dict):
            return {key: expand(item) for key, item in value.items()}
        if isinstance(value, list):
            return [expand(item) for item in value]
        return value

    try:
        connections = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigurationError("无法读取 MCP 配置，请检查文件路径及 JSON 格式") from exc
    if not isinstance(connections, dict) or not connections:
        raise ConfigurationError("MCP 配置必须是非空的 SDK connections 对象")
    if header_overrides is not None:
        # Browser identity replaces config headers before placeholder expansion.
        # Each parse is independent; neither config nor process env is mutated.
        conn = connections.get("weknora") or {}
        headers = dict(conn.get("headers") or {})
        identity = {"x-weknora-user-token", "x-tenant-id", "x-weknora-knowledge-base-ids"}
        overridden = {key.lower() for key in header_overrides}
        headers = {key: value for key, value in headers.items()
                   if key.lower() not in identity | overridden}
        headers.update(header_overrides)
        conn["headers"] = headers
    expanded = expand(connections)
    # The LangChain client is the one component where a model picks tools, so it
    # talks to the five-tool knowledge core (write actions are not on that
    # surface at all, and agent.py additionally filters to the read-only two).
    return core_connections(expanded)


async def run(question, model, connections, *, timeout=120, recursion_limit=20):
    async with asyncio.timeout(timeout):
        agent = await build_agent(model, connections)
        return await agent.ainvoke(
            {"messages": [{"role": "user", "content": question}]},
            config={"recursion_limit": recursion_limit},
        )


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="纯 LangChain + WeKnora MCP 问答 Agent")
    parser.add_argument("--question", required=True, help="本次问题")
    parser.add_argument("--mcp-config", type=Path, default=root / "mcp.json")
    parser.add_argument("--env-file", type=Path, default=root / ".env")
    args = parser.parse_args()
    if not args.question.strip():
        parser.error("问题不能为空")
    load_dotenv(args.env_file, override=False)
    try:
        connections = load_connections(args.mcp_config)
        model = ChatOpenAI(
            model=required_env("AGENT_MODEL"),
            base_url=required_env("AGENT_MODEL_BASE_URL"),
            api_key=required_env("AGENT_MODEL_API_KEY"),
            temperature=0, timeout=60, max_retries=0,
        )
        result = asyncio.run(run(args.question, model, connections))
        print(result["messages"][-1].text)
    except ConfigurationError as exc:
        parser.exit(1, f"配置错误：{exc}\n")
    except TimeoutError:
        parser.exit(1, "运行超时（120 秒），请检查 MCP 服务和模型响应。\n")
    except Exception as exc:
        # Upstream errors may carry credentials/response bodies: never dump them.
        parser.exit(1, f"运行失败（{type(exc).__name__}），请检查模型、MCP 地址、身份权限或工具循环限制。\n")


if __name__ == "__main__":
    main()
