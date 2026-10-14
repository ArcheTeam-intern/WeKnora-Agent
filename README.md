# WeKnora-Agent

纯 LangChain Agent 原型：模型 + 标准 MCP 适配器，提供 CLI 与 MCP 验证控制台。MCP 为 Model Context Protocol。

运行代码只有 `main.py`、`agent.py` 和 `webapp.py`（页面在 `web/`）。调用链为配置读取 → `ChatOpenAI` → `MultiServerMCPClient.get_tools()` → `create_agent` → `ainvoke` → 答案。框架负责模型与工具循环，不自建 Agent runtime 或 MCP 协议层。

文档上传、解析、RAG、Wiki、知识图谱、身份权限、任务状态和来源结构均在 WeKnora。资料管理继续使用 WeKnora UI（本机原型地址 `http://127.0.0.1:18180`）。CLI/问答链路只使用只读 MCP 工具；控制台的「工具台」视图会刻意调用全部工具（含 upload/import/add/update/delete 写工具），用于验证主产品将消费的 MCP 封装。

```text
WeKnora-Agent/
  main.py
  agent.py
  webapp.py
  web/index.html
  web/assets/{styles.css,app.js,views.js}
  accounts.json.example     # 复制为 accounts.json 填真实凭据（accounts.json 已 gitignore）
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

MCP 验证控制台（验证主产品将消费的全部 21 项 MCP 能力）：

```powershell
Set-Location E:\GoLandCode\WeKnora-Agent
Copy-Item accounts.json.example accounts.json   # 填入演示账号（本机文件，已 gitignore）
.\.venv\Scripts\python.exe webapp.py
# 打开 http://127.0.0.1:18100 （端口取 WEKNORA_AGENT_WEB_PORT，默认 18100）
```

控制台有三个视图，全部操作经 MCP 完成，右上角「MCP 调用轨迹」抽屉保留每次请求的原始 JSON：

- **资料与解析验证**：上传双通道可切换（multipart `/mcp/:id/uploads` 原样透传，保留字段顺序与 Idempotency-Key；或 `upload_file` 工具 base64 通道）→ `import_document_file` 导入 → 自动跑验证清单（状态轮询 → `read_document` → `list_documents` → 检索 → `wiki_*` → 图谱 → `get_knowledge_base_status`），按知识库 `capability_flags` 与运行时可用性两级门控跳过不适用项，跳过永远带原因；清单结果可下载 JSON。另有 add/update/delete_document 写工具入口（破坏性二次确认）。
- **问答**：双模可切换。默认直连 MCP `ask` 工具（返回 references 引用卡片，支持 session 续问）；或切到 LangChain Agent 模式（模型自主编排只读工具，展示工具轨迹）。
- **MCP 工具台**：`tools/list` 全量工具、按 inputSchema 自动生成参数表单（可切 JSON 编辑）、原始请求/响应面板、破坏性工具二次确认。

登录用 `accounts.json` 里的账号向 WeKnora 换取新鲜 JWT（access token 24 小时过期，控制台不缓存 token，每次都从浏览器请求头转发）。知识库选择是可选的收窄（与 MCP 契约一致：不选=不收窄），顶栏徽章显示端点名称/模式/工具数/KB 范围（经管理接口只读获取）。

逐个实测全部 MCP 工具（需要真实 WeKnora 栈与 accounts.json）：

```powershell
$env:WEKNORA_LIVE_MCP=1
.\.venv\Scripts\python.exe -m pytest tests/test_live_mcp_tools.py -q -s
# 每行输出 pass/skip/fail 与证据；wiki/graph 类按能力门控判定，配置态计 skip 不计 fail
```

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
