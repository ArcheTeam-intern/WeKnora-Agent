# WeKnora-Agent

纯 LangChain Agent 原型：模型 + 标准 MCP 适配器，提供 CLI 与简易演示前端。MCP 为 Model Context Protocol。

运行代码只有 `main.py`、`agent.py` 和 `webapp.py`（页面在 `web/index.html`）。调用链为配置读取 → `ChatOpenAI` → `MultiServerMCPClient.get_tools()` → `create_agent` → `ainvoke` → 答案。框架负责模型与工具循环，不自建 Agent runtime 或 MCP 协议层。

文档上传、解析、RAG、Wiki、知识图谱、身份权限、任务状态和来源结构均在 WeKnora。资料管理继续使用 WeKnora UI（本机原型地址 `http://127.0.0.1:18180`）。本项目仅调用问答所需的只读 MCP 工具，包含 Wiki 和知识图谱。

```text
WeKnora-Agent/
  main.py
  agent.py
  mcp.json
  requirements.txt
  requirements-dev.txt
  .env.example
  README.md
  tests/
  docs/implementation-plan.md
```

使用 Python 3.12+（本机已建立独立 `.venv`）：

```powershell
Set-Location E:\GoLandCode\WeKnora-Agent
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
# 编辑 .env，填写模型、MCP 和 WeKnora 身份配置
.\.venv\Scripts\python.exe main.py --question "根据原始文档、Wiki 和知识图谱，说明项目负责人及依赖关系"
```

简易演示前端（演示用，同一套 Agent 与 .env 配置）：

```powershell
Set-Location E:\GoLandCode\WeKnora-Agent
.\.venv\Scripts\python.exe webapp.py
# 打开 http://127.0.0.1:18100 （端口取 WEKNORA_AGENT_WEB_PORT，默认 18100）
```

页面把每轮问答的 MCP 工具调用轨迹（search_knowledge / read_document / wiki / query_knowledge_graph 等）和最终回答（含 chunk 级引用）实时展示出来。`webapp.py` 用 `.env` 里的 `WEKNORA_DEMO_EMAIL` / `WEKNORA_DEMO_PASSWORD` 自动向 WeKnora 登录换取新鲜 JWT（access token 24 小时过期，这里按需自动重登），其余凭据与 CLI 完全一致。

模型必须支持工具调用及 OpenAI-compatible chat API。更换模型只需改 `AGENT_MODEL`、`AGENT_MODEL_BASE_URL`、`AGENT_MODEL_API_KEY`。

`mcp.json` 保持 SDK connections 结构，`${ENV_NAME}` 在内存中展开，不回写密钥。也可通过 `--mcp-config` 指定自己的配置；`--env-file` 指定环境文件。外部已设置的环境变量优先于 `.env`。

WeKnora 签发端点 token 和用户 JWT；用户 JWT 可来自其登录／主产品身份链路。客户端不执行登录、刷新、角色查询或授权计算。`WEKNORA_KB_IDS` 为 1～10 个已授权知识库 UUID，逗号分隔。选定范围只是收窄范围，最终权限由服务验证。JWT 过期时由调用者提供新值。

为本 Agent 配置只读 MCP 端点。若端点混有导入等额外工具，客户端仅保留显式只读名单并输出工具名告警。上传入口 `/mcp/:endpoint_id/uploads` 和导入工具属于 WeKnora，不交给问答模型。

运行总超时 120 秒，模型 timeout 60 秒、max_retries=0，框架 recursion_limit=20。配置缺失或运行失败退出非零，不打印含上游响应内容的异常堆栈。需要调用原始 SDK 事件时，可直接对 `await build_agent(model, connections)` 的结果使用原生 `astream`，不增加 HTTP/SSE 服务。

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest tests -q
.\.venv\Scripts\python.exe -m pip check
```

测试启动真实 MCP SDK stdio 服务，用预设模型消息验证框架实际执行检索、Wiki、图谱工具，以及写工具隔离、工具错误、配置与总超时。此测试验证协议和框架链路，不能证明真实模型回答准确或线上 WeKnora 检索完整。真实 WeKnora + 模型问答需配置有效 token／JWT 和模型凭据后验证。

WeKnora 部署和评估语料已迁到 `E:\GoLandCode\WeKnora\examples\mcp-validation`，评估门槛及后续工作见该目录 README。旧 HTTP 评估器已归档，不能用于新 CLI。

旧 backend、frontend、deploy、scripts、eval 及历史 docs 的完整归档：`E:\GoLandCode\WeKnora-Agent-archive\20261013-105051`。旧 Agent 前后端容器已停止，WeKnora、其 UI、Redis、Neo4j 和数据卷保留。归档包含本地秘密配置与旧虚拟环境，不应提交或分享。
