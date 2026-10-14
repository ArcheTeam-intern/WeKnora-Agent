"""简易演示前端：单页聊天界面 + 流式问答。

Web 层只做四件事：托管静态页面、用 .env 里的邮箱密码向 WeKnora 换取新鲜
JWT（token 24h 过期，这里按需自动重登，演示不会因过期中断）、把问题交给
与 main.py 完全相同的 LangChain Agent、把工具调用轨迹和最终回答以 SSE 推给
浏览器。检索、Wiki、知识图谱、身份权限等业务逻辑全部留在 WeKnora（MCP）侧。
"""
import asyncio
import json
import logging
import os
from pathlib import Path

import httpx
import uvicorn
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from sse_starlette.sse import EventSourceResponse
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route

from agent import build_agent
from main import ConfigurationError, load_connections, required_env

ROOT = Path(__file__).resolve().parent
log = logging.getLogger("webapp")

# 与 CLI 一致的运行边界：单轮总超时、框架递归上限。
ANSWER_TIMEOUT = 180
RECURSION_LIMIT = 20

state = {
    "model": None,
    "connections": None,
    "agent": None,
    "build_lock": None,
}


def weknora_base() -> str:
    url = os.environ.get("WEKNORA_MCP_URL", "").strip()
    return url.rsplit("/mcp/", 1)[0] if "/mcp/" in url else url.rstrip("/")


async def login_for_token() -> str:
    """用邮箱密码换新鲜 access token；这是前端保持登录态的唯一机制。"""
    email = required_env("WEKNORA_DEMO_EMAIL")
    password = required_env("WEKNORA_DEMO_PASSWORD")
    base = weknora_base()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(f"{base}/api/v1/auth/login",
                                 json={"email": email, "password": password})
    if resp.status_code != 200:
        raise ConfigurationError(f"WeKnora 登录失败（HTTP {resp.status_code}），请检查演示账号配置")
    body = resp.json()
    token = body.get("token") or ""
    if not token:
        raise ConfigurationError("WeKnora 登录响应中没有 token")
    return token


async def ensure_agent(force: bool = False):
    """构建并缓存 Agent；force=True 用新 token 重建连接。"""
    if state["build_lock"] is None:
        state["build_lock"] = asyncio.Lock()
    async with state["build_lock"]:
        if state["agent"] is not None and not force:
            return state["agent"]
        token = await login_for_token()
        connections = state["connections"] or load_connections(ROOT / "mcp.json")
        connections["weknora"]["headers"]["X-WeKnora-User-Token"] = token
        if state["model"] is None:
            state["model"] = ChatOpenAI(
                model=required_env("AGENT_MODEL"),
                base_url=required_env("AGENT_MODEL_BASE_URL"),
                api_key=required_env("AGENT_MODEL_API_KEY"),
                temperature=0, timeout=60, max_retries=0,
            )
        state["connections"] = connections
        state["agent"] = await build_agent(state["model"], connections)
        log.info("agent ready (model=%s)", os.environ.get("AGENT_MODEL"))
        return state["agent"]


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


async def stream_answer(question: str):
    """跑一轮 Agent，把工具轨迹与最终回答逐条推给浏览器。"""
    yield {"data": json.dumps({"type": "status", "text": "正在检索 WeKnora 知识库…"},
                              ensure_ascii=False)}
    agent = None
    try:
        agent = await ensure_agent()
    except Exception as exc:  # noqa: BLE001 - 配置类错误直接报告类型
        yield {"data": json.dumps(
            {"type": "error", "message": f"初始化失败（{type(exc).__name__}），请检查模型与 WeKnora 配置"},
            ensure_ascii=False)}
        return

    inputs = {"messages": [{"role": "user", "content": question}]}
    config = {"recursion_limit": RECURSION_LIMIT}
    answer = ""
    for attempt in (1, 2):
        try:
            async for chunk in agent.astream(inputs, config=config,
                                             stream_mode="updates"):
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
                                {"type": "tool_result", "name": getattr(msg, "name", ""),
                                 "status": getattr(msg, "status", "") or "success"},
                                ensure_ascii=False)}
                        elif kind == "ai":
                            text = msg.text() if hasattr(msg, "text") else _safe_text(msg.content)
                            if text:
                                answer = text
            break
        except asyncio.TimeoutError:
            yield {"data": json.dumps(
                {"type": "error", "message": f"运行超时（{ANSWER_TIMEOUT} 秒）"}, ensure_ascii=False)}
            return
        except Exception as exc:  # noqa: BLE001 - 不向上游细节泄露给浏览器
            unauthorized = "401" in str(exc) or "unauthorized" in str(exc).lower()
            if unauthorized and attempt == 1:
                # token 过期：重登并重建 Agent 后重试一次。
                try:
                    agent = await ensure_agent(force=True)
                    continue
                except Exception:  # noqa: BLE001
                    pass
            yield {"data": json.dumps(
                {"type": "error",
                 "message": f"运行失败（{type(exc).__name__}），请检查 WeKnora 服务、模型凭据或重试"},
                ensure_ascii=False)}
            return
    else:
        return

    if answer:
        yield {"data": json.dumps({"type": "answer", "text": answer}, ensure_ascii=False)}
    else:
        yield {"data": json.dumps(
            {"type": "error", "message": "模型没有返回内容，请重试"}, ensure_ascii=False)}


async def chat(request: Request):
    body = await request.json()
    question = (body.get("question") or "").strip()
    if not question:
        return JSONResponse({"error": "问题不能为空"}, status_code=400)
    return EventSourceResponse(stream_answer(question))


async def info(request: Request):
    kbs = [k for k in os.environ.get("WEKNORA_KB_IDS", "").split(",") if k.strip()]
    return JSONResponse({
        "model": os.environ.get("AGENT_MODEL", ""),
        "mcp_url": os.environ.get("WEKNORA_MCP_URL", ""),
        "knowledge_bases": len(kbs),
    })


async def index(request: Request):
    return FileResponse(ROOT / "web" / "index.html")


async def healthz(request: Request):
    return JSONResponse({"status": "ok"})


def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    load_dotenv(ROOT / ".env", override=False)
    port = int(os.environ.get("WEKNORA_AGENT_WEB_PORT", "18100"))
    app = Starlette(routes=[
        Route("/", index),
        Route("/api/info", info),
        Route("/api/chat", chat, methods=["POST"]),
        Route("/healthz", healthz),
    ])
    log.info("简易演示前端启动：http://127.0.0.1:%s", port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
