# WeKnora-Agent

纯 LangChain Agent 原型：模型 + 标准 MCP 适配器，提供 CLI 与 MCP 验证控制台。MCP 为 Model Context Protocol。

运行代码只有 `main.py`、`agent.py` 和 `webapp.py`（页面在 `web/`）。调用链为配置读取 → `ChatOpenAI` → `MultiServerMCPClient.get_tools()` → `create_agent` → `ainvoke` → 答案。框架负责模型与工具循环，不自建 Agent runtime 或 MCP 协议层。

文档上传、解析、RAG、Wiki、知识图谱、身份权限、任务状态和来源结构均在 WeKnora。资料管理继续使用 WeKnora UI（本机原型地址 `http://127.0.0.1:18180`）。CLI/问答链路只使用只读 MCP 工具；控制台的「开发诊断」视图会刻意调用全部工具（含 upload/import/add/update/delete 写工具），用于验证主产品将消费的 MCP 封装。

```text
WeKnora-Agent/
  main.py
  agent.py
  webapp.py
  web/index.html
  web/assets/{session.js,styles.css,app.js,views.js}
  scripts/refresh-credential.ps1   # 一条命令签发/刷新本机凭证
  mcp.json
  requirements.txt
  requirements-dev.txt
  .env.example
  README.md
  tests/
  docs/
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
powershell -ExecutionPolicy Bypass -File scripts\refresh-credential.ps1   # 一条命令签发/刷新凭证
.\.venv\Scripts\python.exe webapp.py
# 打开 http://127.0.0.1:18100 （端口取 WEKNORA_AGENT_WEB_PORT，默认 18100）
```

连接工作台只需两步：页面右上角「配置 Token」→ 点「🔄 读取本机凭证」→「连接工作台」。（也可以粘贴 JWT 或导入凭证 JSON；凭据在通过 MCP 校验前不会生效，只保存在当前标签页。）

控制台有三个视图，全部操作经 MCP 完成，右上角「MCP 调用轨迹」抽屉保留每次请求的原始 JSON：

- **资料解析**：可直接「＋ 新建知识库」（经 MCP `create_knowledge_base`，建完自动刷新并选中；受限端点会把新库加入自己的范围）；**上传目标知识库**与**解析引擎**各自独立选择（引擎来自 `list_parser_engines` 的真实目录，不可用的引擎带原因且不可选；「使用知识库默认」即不指定）。上传双通道可切换（`upload_file` 工具 base64 通道，或 multipart `/mcp/:id/uploads` 原样透传）→ `import_document_file` 携带 `process_config` 导入 → 状态行显示「解析/索引/请求引擎/实际引擎」，即 `applied_parser_engine` 与请求的规则对照。
- **知识问答**：**问答范围**多选知识库（或「全部可用」；未选择时发送按钮禁用）与上传目标互不干扰；**问答模式**用 WeKnora 原生 `ask` 的 `quick-answer` / `smart-reasoning`（模式经 MCP 参数提交，由服务端校验并回显）。切换范围或模式会开启新会话并丢弃旧范围/旧模式在途的回答；同一会话内可带 `session_id` 续问。控制台本身不含任何第三方编排框架——它验证的是主产品将来直接消费的 MCP 表面。
- **开发诊断**：`tools/list` 全量工具（按 inputSchema 自动生成参数表单，可切 JSON 编辑）、原始请求/响应面板、破坏性工具二次确认；每个工具都有「填入示例」——参数用当前知识库的真实 id 填好（最近文档、最近上传），点运行即可看到真实结果；验证清单（状态轮询 → `read_document` → `list_documents` → 检索 → `wiki_*` → 图谱 → `get_knowledge_base_status`，按 `capability_flags` 两级门控跳过并注明原因，可下载 JSON）。写工具就在工具目录里，运行时二次确认。

凭证由 WeKnora 验证目录里的独立工具 `issue_user_token.py` 正式签发（access token 24 小时过期）；`scripts/refresh-credential.ps1` 只是它的本机便捷入口，签发后会把新 JWT 同步进 `.env` 供 CLI 使用，并把凭证文件留在标准位置供工作台一键读取（`GET /api/local-credential` 只在显式设置 `WEKNORA_CREDENTIAL_FILE` 且请求来自本机时读取）。工作台自身不做登录、不保存密码、不自动续期；知识库范围是可选的收窄（与 MCP 契约一致：不选=不收窄），顶栏显示当前身份、端点名称/模式/工具数与范围摘要（只读）。

逐个实测全部 MCP 工具（需要真实 WeKnora 栈、新鲜用户 JWT 与显式指定的测试库）：

```powershell
$env:WEKNORA_LIVE_MCP='1'; $env:WEKNORA_TEST_KB='<本轮允许写入的知识库>'
.\.venv\Scripts\python.exe -m pytest tests/test_live_mcp_tools.py -q -s
# 每行输出 pass/skip/fail 与证据；写类工具用本轮唯一 uuid 草稿自清；
# wiki/graph 类按能力门控判定，配置态计 skip 不计 fail
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
