# WeKnora-Agent

纯 LangChain Agent 原型：模型 + 标准 MCP 适配器，提供 CLI 与 MCP 验证控制台。MCP 为 Model Context Protocol。

运行代码只有 `main.py`、`agent.py` 和 `webapp.py`（页面在 `web/`）。调用链为配置读取 → `ChatOpenAI` → `MultiServerMCPClient.get_tools()` → `create_agent` → `ainvoke` → 答案。框架负责模型与工具循环，不自建 Agent runtime 或 MCP 协议层。

文档上传、解析、RAG、Wiki、知识图谱、身份权限、任务状态和来源结构均在 WeKnora。工作台模拟主产品，通过 MCP 展示知识库与资料管理、检索、Wiki、图谱和问答；WeKnora 管理 UI（本机原型地址 `http://127.0.0.1:18180`）负责完整后台配置。CLI 与工作台都只调用**七工具知识核心**（`/mcp/core/:endpoint_id`）：`knowledge_base`、`ingest_document`、`search_knowledge`、`read_document`、`ask`、`wiki_workspace`、`agent_workspace`。旧兼容工具入口（`/mcp/:endpoint_id`）保留给未迁移的客户端，`tests/test_live_mcp_tools.py` 继续把它作为兼容面回归。

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

MCP 验证控制台（验证主产品将消费的七工具知识核心 `/mcp/core/:id`）：

```powershell
Set-Location E:\GoLandCode\WeKnora-Agent
powershell -ExecutionPolicy Bypass -File scripts\refresh-credential.ps1   # 一条命令签发/刷新凭证
.\.venv\Scripts\python.exe webapp.py
# 打开 http://127.0.0.1:18100 （端口取 WEKNORA_AGENT_WEB_PORT，默认 18100）
```

连接工作台只需两步：页面右上角「配置 Token」→ 点「🔄 读取本机凭证」→「连接工作台」。（也可以粘贴 JWT 或导入凭证 JSON；凭据在通过 MCP 校验前不会生效，只保存在当前标签页。）

控制台有九个视图，全部知识业务操作经 MCP 完成，右上角「MCP 调用轨迹」抽屉保留每次请求的原始 JSON：

- **知识库概览**：选择当前账号可见的知识库，查看文档与分块数量、Wiki 页面与待处理状态、图谱运行状态、真实解析引擎目录和端点问答配置；可携带当前库跳转到 Wiki、图谱或问答。配置启用和运行可用分开显示，缺失计数显示未知。
- **统一检索**：独立多选知识库与文档/Wiki/图谱来源，选择混合、语义或关键词模式；支持文档字面匹配。按来源展示证据与部分失败，文档可回读、Wiki 可读页、图谱可跳转到实际命中的库。
- **Wiki 知识**：独立选库，按目录分类浏览、过滤或搜索，阅读主题正文和内部链接，按页面对应的引用回读原文。通过聚合工具 `wiki_workspace` 新建、编辑、删除页面，预览和恢复历史版本；编辑携带版本号，端点显式写入许可与知识库权限均由 WeKnora 检查。可从当前页跳转到原生 Wiki 页面链接图。
- **图谱探索**：独立选库，输入实体或关键词，通过 MCP 返回的真实实体和关系绘制 SVG 图，可缩放、平移、点选节点/关系，查看关系列表及各自的来源。画布只放实体与关系；其余检索片段位于画布外默认折叠的「相关资料」，可展开阅读和回读原文，不作为关系依据。局部查询结果不冒充全量拓扑，关系缺少来源时明确显示未提供。

图谱类型可切换到 **Wiki 页面链接图**，与 WeKnora 原生 Wiki Graph 对应：节点为页面，连线来自正文中的 `[[slug|标题]]`。支持概览和以页面 slug 为中心查看邻接页；点击节点或链接可进入对应 Wiki 页面维护正文，服务端同步链接。它与文档抽取的实体关系图分别展示；没有新增直接修改 Neo4j 连线的独立业务实现。文件夹整理、质量问题单、自动修复和全库重建暂未增加产品入口。

本轮接口、权限与真实验收记录见 [Wiki 管理与两种图谱](docs/2026-10-21-wiki-management-and-graphs.md)。

- **资料解析**：可直接「＋ 新建知识库」（经 MCP `knowledge_base` 的 `create` 动作，建完自动刷新并选中；受限端点会把新库加入自己的范围）；**上传目标知识库**与**解析引擎**各自独立选择（引擎来自 `knowledge_base.get` 返回的真实目录，不可用的引擎带原因且不可选；「使用知识库默认」即不指定）。「上传并导入」是一次 `ingest_document.submit`：文件字节 base64 随请求发送，`process_config` 同次提交解析规则；随后轮询 `ingest_document.status` 显示上传/解析/索引各阶段与「请求引擎/实际引擎」，解析完成后用 `read_document.read` 回读分块数与原文预览。
- **知识库文档**：面向日常使用的文档管理页——选择知识库后自动加载文档目录（`read_document.list` 分页，显示标题、类型、解析状态和更新时间），点任一行在右侧读回分块原文（`read_document.read`，附分块序号与 `chunk_id`）；支持上一组/下一组翻页，以及在单篇文档内做字面检索（命中块带「命中/上文/下文」标记，结果截断时可「继续往后找」）。切换知识库、翻页或换身份都会作废旧请求，页面不会串数据。
- **智能体管理**：通过 `agent_workspace` 列出、查看、新建、编辑、复制、删除 WeKnora 原生智能体；配置知识问答类型、提示词、运行模式与默认知识库。内置智能体只读，可复制后编辑；写入受原生账号权限约束。详见 [原生智能体管理与问答选择](docs/2026-10-21-native-agent-workspace.md)。
- **知识问答**：**问答范围**多选知识库（或「全部可用」；未选择时发送按钮禁用）与上传目标互不干扰；**问答模式**用核心 MCP的 `ask` 的 `quick-answer` / `smart-reasoning`（模式经 MCP 参数提交，由服务端校验并回显）。另可选择「指定智能体」，从 MCP 返回的原生目录选择，并发送 `ask.agent_id`，同时把明确选中的知识库作为参数提交。切换范围、模式或智能体会开启新会话并丢弃旧范围/旧模式在途的回答；同一会话内可带 `session_id` 续问。控制台本身不含任何第三方编排框架——它验证的是主产品将来直接消费的 MCP 表面。
- **开发诊断**：`tools/list` 展示的就是 core 面的七个工具（按 inputSchema 自动生成参数表单，可切 JSON 编辑）、原始请求/响应面板、`ingest_document` 写操作二次确认；每个工具都带中文「用途 / 动作 / 自测步骤 / 判定标准 / 常见错误」说明，参数逐字段给出中文详解（含默认值与书写格式）；布尔参数是三态下拉（不传=服务端默认 / true / false），默认 `true` 的字段也能显式关掉；表单与 JSON 互切会保留已填内容，schema 外的键在往返中不丢失；「填入示例 / 换一个示例」按顺序循环多个可直接运行的示例——列库、看库详情、提交演示文档、轮询阶段、混合/字面/Wiki/图谱检索、读正文与 Wiki 页、三种问答模式续问，参数全部取自当前真实状态并附预期结果；验证清单覆盖原有五工具的读取动作（`knowledge_base.list/get` → `ingest_document.status` → `read_document.read/list` → `search_knowledge` 文档/字面/Wiki/图谱），按 `capability_flags` 与运行时可用性两级门控跳过并注明原因，可下载 JSON。

凭证由 WeKnora 验证目录里的独立工具 `issue_user_token.py` 正式签发（access token 24 小时过期）；`scripts/refresh-credential.ps1` 只是它的本机便捷入口，签发后会把新 JWT 同步进 `.env` 供 CLI 使用，并把凭证文件留在标准位置供工作台一键读取（`GET /api/local-credential` 只在显式设置 `WEKNORA_CREDENTIAL_FILE` 且请求来自本机时读取）。工作台自身不做登录、不保存密码、不自动续期；知识库范围是可选的收窄（与 MCP 契约一致：不选=不收窄），顶栏显示当前身份、端点名称/模式/工具数与范围摘要（只读）。

逐个实测旧兼容面的原有 22 个 MCP 工具（需要真实 WeKnora 栈、新鲜用户 JWT 与显式指定的测试库；核心 MCP 面由控制台与验证清单覆盖）：

```powershell
$env:WEKNORA_LIVE_MCP='1'; $env:WEKNORA_TEST_KB='<本轮允许写入的知识库>'
.\.venv\Scripts\python.exe -m pytest tests/test_live_mcp_tools.py -q -s
# 每行输出 pass/skip/fail 与证据；写类工具用本轮唯一 uuid 草稿自清；
# wiki/graph 类按能力门控判定，配置态计 skip 不计 fail
```

模型必须支持工具调用及 OpenAI-compatible chat API。更换模型只需改 `AGENT_MODEL`、`AGENT_MODEL_BASE_URL`、`AGENT_MODEL_API_KEY`。

`mcp.json` 保持 SDK connections 结构，`${ENV_NAME}` 在内存中展开，不回写密钥。也可通过 `--mcp-config` 指定自己的配置；`--env-file` 指定环境文件。外部已设置的环境变量优先于 `.env`。

WeKnora 签发端点 token 和用户 JWT；用户 JWT 可来自其登录／主产品身份链路。客户端不执行登录、刷新、角色查询或授权计算。`WEKNORA_KB_IDS` 为 1～10 个已授权知识库 UUID，逗号分隔。选定范围只是收窄范围，最终权限由服务验证。JWT 过期时由调用者提供新值。

为本 Agent 配置 MCP 端点。问答模型只看到只读名单（`search_knowledge`、`read_document`），写入动作（`knowledge_base.create`、`ingest_document.submit`）由控制台的显式用户操作触发，不交给模型。文件字节随 `ingest_document.submit` 的 base64 载荷发送，仓库不再使用 `/mcp/:id/uploads` 兼容通道。

运行总超时 120 秒，模型 timeout 60 秒、max_retries=0，框架 recursion_limit=20。配置缺失或运行失败退出非零，不打印含上游响应内容的异常堆栈。需要调用原始 SDK 事件时，可直接对 `await build_agent(model, connections)` 的结果使用原生 `astream`，不增加 HTTP/SSE 服务。

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest tests -q
.\.venv\Scripts\python.exe -m pip check
```

测试启动真实 MCP SDK stdio 服务，用预设模型消息验证框架实际执行检索、Wiki、图谱工具，以及写工具隔离、工具错误、配置与总超时。此测试验证协议和框架链路，不能证明真实模型回答准确或线上 WeKnora 检索完整。真实 WeKnora + 模型问答需配置有效 token／JWT 和模型凭据后验证。

WeKnora 部署和评估语料已迁到 `E:\GoLandCode\WeKnora\examples\mcp-validation`，评估门槛及后续工作见该目录 README。旧 HTTP 评估器已归档，不能用于新 CLI。

旧 backend、frontend、deploy、scripts、eval 及历史 docs 的完整归档：`E:\GoLandCode\WeKnora-Agent-archive\20261013-105051`。旧 Agent 前后端容器已停止，WeKnora、其 UI、Redis、Neo4j 和数据卷保留。归档包含本地秘密配置与旧虚拟环境，不应提交或分享。
