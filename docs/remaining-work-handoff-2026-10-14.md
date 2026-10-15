# WeKnora MCP 纠偏：剩余工作交接

更新时间：2026-10-14 11:05（Asia/Shanghai）。用户已要求停止本轮实施，将剩余工作交给其他模型。此文档是继续执行入口；[完整纠偏方案](correction-plan-2026-10-14.md) 保留设计细节，本文覆盖其中过时的状态和待办。

## 1. 已确认的目标，执行时不要重新扩张

用户已确认：**“先用 WeKnora 现有问答，Agent 仅验证 MCP”。**

- WeKnora：现有页面、文档上传、解析和状态、日常问答、RAG、Wiki、实体知识图谱、身份权限，以及这些业务的 MCP 封装。
- WeKnora-Agent：标准 LangChain/LangGraph、模型初始化、MCP 配置和工具发现、CLI/library 调用。运行生产文件只保留 `main.py`、`agent.py`。
- 部署、测试语料、MCP 自检、评估和报告：放在 `WeKnora/examples/mcp-validation`，不成为 Agent 的业务模块或运行依赖。
- Wiki 和实体图谱都是核心功能。Wiki 链接图与 Neo4j 实体关系图要分别验收。
- 不重建 Agent Web、登录代理、JWT 刷新/缓存、上传代理、证据 Registry、自研模型/工具包装器或 Agent runtime。不增加 Go→Python 日常问答适配层。
- 首期先跑通核心链路。保留 WeKnora 已有业务，不在这一轮大规模删除其功能。

MCP 的标准名称是 **Model Context Protocol**；服务侧业务封装才是本项目主要改动对象。

## 2. 接手时的工作区和已完成内容

| 项目 | 路径 | 当前分支 / 提交 |
| --- | --- | --- |
| WeKnora | `E:/GoLandCode/WeKnora` | `codex/mcp-prototype-correction` / `d68b0f47c` |
| WeKnora-Agent | `E:/GoLandCode/WeKnora-Agent` | `codex/mcp-prototype-correction` / `cefb0af` |

### 2.1 已完成：Agent 回到纯结构

提交 `cefb0af`：`refactor: restore pure LangChain MCP validation client`。

- 删除 `webapp.py`、`web/index.html`，移除直接声明的 Starlette、sse-starlette、Uvicorn 依赖。
- README 明确业务入口是 WeKnora 原页面/问答，Agent 是 CLI/library 验证客户端。
- 新增 `tests/test_project_boundary.py`，约束生产目录和依赖边界。
- CLI 缺配置测试使用独立临时 `--env-file`，避免测试误加载真实 `.env`。
- `main.py`、`agent.py` 的标准运行结构没有改动；实际 `.env` 没有修改。
- 已停止此前 Agent `webapp.py` 的两个已核对进程，WeKnora UI/服务仍运行。
- 实施者和两个独立审查分别确认：**16 项测试通过，pip check 无冲突；规范和代码质量审查通过。**

SDK 传递依赖里仍可能存在 Web 包，这是正常的；不能为了删净 SDK 内部依赖而复制 MCP 协议。

### 2.2 尚未完成：本轮新增的 WeKnora 生产修复

**这里的“没有生产 Go 修改”仅指本轮纠偏在交接时没有新增相对 HEAD 的生产 Go 工作区差异，不表示此前 R1–R14 未实现。** R1–R14 已包含在基线提交 `d68b0f47c` 中（27 个文件，包含 MCP、上传、来源和调度修复），应保留，并继续补本文列出的剩余缺口。本轮尚未创建新的 WeKnora 提交。

再次核对当前 `E:/GoLandCode/WeKnora`：HEAD 为 `d68b0f47c`；暂存区为空；相对 HEAD 的 `internal/` 只有下面两个测试文件，无生产 Go 差异。交接时留下如下未提交内容：

| 文件 | 状态 | 用途 |
| --- | --- | --- |
| `internal/mcpserver/correction_status_test.go` | 新增、未跟踪 | nil 处理时间、processing 计数失败、缺 chunk service 的回归 |
| `internal/mcpserver/graph_provenance_test.go` | 修改，新增一项测试 | 多 chunk 来源不能共用一个 quote 视为全部 verified；错误 KB/document 绑定不能泄漏 |
| `examples/mcp-validation/.gitignore` | 修改，新增 `*.local.json` | 防止验收端点秘密配置被提交 |

两组新回归**尚未运行 RED/GREEN，也未 gofmt**。下一模型必须先审查测试并运行失败用例，不要当成已完成修复。Go 基线编译开始于这些测试写入前，基线通过不能证明新测试通过。

以下六个包原有基线已在 Linux CGO/SQLite 容器通过：`internal/mcpserver`、`internal/middleware`、`internal/router`、`internal/types`、`internal/application/repository`、`internal/application/repository/retriever/neo4j`。本轮还没有验证完整 `internal/application/service` / `internal/agent/tools`。

WeKnora 另有用户原有未跟踪文件：`LOCAL-SETUP.md`、两份中文架构/功能文档、`docker-compose.override.yml`；Agent 有旧方案/审查文档。全部保留，不使用 `git add .`、`reset --hard`、`clean -fd` 覆盖用户工作。

若接手模型看到大量 `internal/` 工作区改动，先执行以下只读核对，确认仓库目录、HEAD 和比较基准；当前文档是交接时快照，不能覆盖之后其他模型实际写入的改动：

```powershell
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short
git diff HEAD --stat
git diff --cached --stat
```

**默认保留现有改动，逐文件审查、回归后从当前状态续做，不回滚重做。** 区分已提交基线修复、接手后新增且未验证的修复、以及仍缺失的功能；不要把提交历史或相对旧基准的 PR/分支差异误认为未提交变化。若另一个 checkout 确有新增生产修改，保留它们并更新交接状态，不能凭本文旧快照直接删除。

## 3. 已准备好的真实环境和验收资料

### 3.1 服务与私密配置

| 对象 | 当前情况 |
| --- | --- |
| WeKnora API/MCP | `http://127.0.0.1:18082`，`WeKnoraAgent-app` 健康 |
| 原业务页面 | `http://127.0.0.1:18180`，`WeKnoraAgent-ui`，镜像 `wechatopenai/weknora-ui:v0.8.2` |
| Redis / Neo4j | 原有容器健康，保留原有数据卷 |
| Compose | `WeKnora/examples/mcp-validation/deploy/compose.prototype.yml` |
| 服务环境秘密 | `deploy/.env.prototype`；不要输出其内容 |
| 调用方模型/身份配置 | `WeKnora-Agent/.env`；只在本机使用，不输出、不提交 |
| 新验收端点配置 | `WeKnora/examples/mcp-validation/deploy/acceptance.local.json`，已被 gitignore 排除 |

`acceptance.local.json` 包含 `base_url`、`kb_id`、`workspace_id`、`endpoint_id`、`endpoint_token`、`documents`。**endpoint_token 是秘密，禁止打印整份文件、写进报告或提交。** `.env` 中 JWT 可能随时间过期；由调用方按现有身份流程准备有效配置，不能在 Agent 中加自动登录/刷新补救。

原测试知识库和正式资料都保留，未清库、未删除数据卷。已有旧“图谱验证 KB”未正确开启抽取，不要使用其 `GRAPH_EXTRACTION_NOT_CONFIGURED` 结果代替本次正向验证。

### 3.2 新隔离知识库已真实生成内容

名称：`MCP纠偏核心验收-20261014`。

知识库 ID：`54281b47-333b-41f3-a6ad-860a543267b8`，workspace `2`。它仅用于本轮隔离验收。

配置已真实启用 keyword/vector、Wiki、graph。摘要/Wiki 模型为已有 `deepseek-flash`，embedding 为已有 `qwen3.7-text-embedding-flash`；密钥不在本文。抽取类型含人员、项目、服务，关系含负责、依赖，已设置 enabled/text/tags/nodes/relations。不要只设置 `graph_enabled` 而漏掉 extract_config。

两份文件通过 MCP 二进制 upload + `import_document_file` 实际导入：

| 文件 / 原文 | knowledge ID | 原文 chunk ID |
| --- | --- | --- |
| `负责人.md`：张三负责项目A。张三承担项目A的实施协调、上线审批和运行维护。 | `49efedca-c27f-4085-b8d5-0df3a0d339c1` | `25c45de3-a612-4b63-aaec-ed152e6990d7` |
| `依赖.md`：项目A依赖服务B。服务B提供认证和账户管理，项目A上线前必须完成服务B的联调。 | `22161225-db8a-4dd9-99f6-4d1820ef1fc2` | `8d5d171a-d5c9-416a-8b05-b9de3e3f0501` |

最新保存的原始 MCP probe 证明：

- `get_knowledge_base_status`：documents=2、chunks=4、processing_documents=0、counts_known=true。
- Wiki：8 页，pending_tasks=0，is_active=false；有真实 index、summary、entity、concept 页面。
- `wiki_read_page(entity/xiang-mu-a)` 正文含两份资料的信息和来源 ID；**目前 V2 refs 的 quote 仍为空、provenance_status=unknown，来源核验尚未完成。**
- `wiki_graph`：8 nodes、17 edges，类型为 Wiki 链接图。
- `query_knowledge_graph(项目A)`：真实 Neo4j 关系 `张三→负责→项目A`、`项目A→依赖→服务B`，分别绑定上表自己的 knowledge/chunk；两份原文也在结果中返回。
- search、Wiki index/list/read、Wiki graph、实体查询已经正向调用；尚未把全部 13 个只读工具和异常矩阵整理成正式自动验收。

原始结果：`WeKnora/examples/mcp-validation/eval/reports/current-execution/probe.json`。上传文件也在该目录。目录被忽略，资料在当前机器上可复用，不能认为已随 Git 交付。

临时探查脚本：`WeKnora/.planning/2026-10-14-correction-execution/probe.py`。它读取本机秘密、不打印请求头，保存返回体，**只是诊断脚本，不是自动通过/失败验收器**。重跑前确认 token 和端点仍有效。

### 3.3 本轮真实复现的新故障

导入后立即 `get_document_status`，服务返回：

```text
panic recovered in get_document_status tool handler:
runtime error: invalid memory address or nil pointer dereference
```

原因是 `Knowledge.ProcessedAt` 为 `*time.Time`，新文档可能是 nil；`describeKnowledgeStatus` 直接调用 `k.ProcessedAt.IsZero()`。已有 `k == nil` 防御并不能覆盖这个故障。导入已成功，不要因这个状态读取故障重复创建文档。

## 4. 剩余任务，按顺序执行

### P0-1：修正文档状态和统计可信度（原任务 D）

文件：`internal/mcpserver/tools_status.go`、`correction_status_test.go`。

1. 先运行新增 timestamp 回归，确认 nil panic；加 nil guard，不伪造 processed_at。
2. `CountsKnown` 必须在文档、处理中任务、chunk 三项查询都实际成功时才为 true。当前文档计数成功后设 true，processing 查询失败或缺 chunk service 不会清除。
3. 查询失败/服务缺失要保留 unknown 语义并写明缺失项；不能把 unknown 的 0 当“没有任务”。成功统计路径保持原行为。
4. 新导入文档从 pending 到 completed 实测，避免只测 completed 行。必要时用新文件字节导入隔离 KB；不要覆盖现有两份验收原文。

验收：新文档状态不 panic；所有查询正常才 known；部分错误的测试通过，真实状态可读。

### P0-2：逐 chunk 的图谱来源核验（原任务 D）

文件：`internal/mcpserver/tools_graph.go`、`graph_provenance_test.go`；必要时核对 `internal/agent/tools/query_knowledge_graph*` 和 Neo4j repository。

1. `graphChunkIndex` 当前只保存 quote/KB，缺少 document binding；改为明确保留实际结果的 knowledge、KB、chunk 和 text。
2. `graphEdgeRefs` 当前多个 chunk 汇成一个 ref，只要一个 quote 非空就全部 verified。按 chunk 分条，或用等价可解释结构逐来源标状态；**一个可读 chunk 不能验证其他未读 chunk**。
3. 核对该结果属于关系自身的 knowledge/KB/chunk，并属于授权 KB 集合；不信任未经验证的 edge.quote，不借用查询中其他关系的文本。
4. 未读取、缺失、错误绑定或范围外来源不能输出其私密 quote，不能错误标 verified。对不存在来源保持 unknown/unverified_source；具体脱敏字段遵循已有协议和权限行为。
5. 已加入回归包含可读 c1、unread、foreign 三个来源，但未运行、未格式化；先审查其断言是否符合最终输出契约，再 RED/GREEN。
6. 保留每条关系真实标识、方向和来源合并行为。补测同一关系两次抽取来自不同 chunk、不同文档同名实体、历史无来源关系、cap 截断、部分查询故障。已存在正确修复不要回滚。

验收：两条真实关系分别能回读自己的原文；多来源测试不虚增已验证证据；查询错误/截断被明确报告。

### P0-3：Wiki 来源由服务授权读取后核验（原任务 D）

文件：`internal/mcpserver/tools_wiki.go`、`tools_wiki_test.go`、`internal/types/wiki_page.go`。

1. 当前 read enrichment、list summary 使用 `WikiPageSourceRefsToV2`：legacy refs 仅解析 ID、填 page KB、unknown。保留该兼容能力，但不能把 ID 解析当来源验证。
2. 在 WeKnora 侧用已有 `knowledgeInScope` / `scopedKBContext` 等权限路径查真实文档及 chunk，核对 owner tenant、document、KB，输出真实 KB 和原文 quote。
3. 文档级 refs 没有 chunk 时，按明确且有限的读取规则获取授权原文，不能随意找一句便声称验证整个文档。quote 只证明来源读取，事实支持仍需逐事实复核。
4. 已含 V2 quote 的数据也要重新校验访问权限，不能信任持久化来源字段越过范围；跨空间共享按原有授权路径处理。
5. 无权限不得泄漏来源 ID/文本；已授权但来源缺失/不可读保持 unknown/unverified。不要把 page KB 假设为来源 KB。
6. 补 legacy/V2、缺失 chunk、跨 KB、跨 tenant 共享、越权来源回归。客户端不得猜来源映射。

验收：隔离 KB 的 Wiki index→search→read_page→list_pages→wiki_graph 全部有正向结果；项目A页的两份来源有真实 quote，并能独立 `read_document` 回读。Wiki 链接图不能替代实体图谱。

### P0-4：巩固上传幂等、回执和清理并发恢复（原任务 E）

实际文件均在 `internal/mcpserver/`：`upload_staging.go`、`upload_repository.go`、`tools_import.go`、`upload_transport.go`、`upload_sweep.go` 及相应测试。

| 待补缺口 | 最小实现和回归要求 |
| --- | --- |
| 并发首次上传同 key | `Stage` 的 Create 唯一键竞争失败后回查原回执，比较本次已计算的 KB、size/hash、调用方绑定；同 bytes 重放、不同 bytes 冲突，不返回无意义内部错误 |
| 创建文档后 Complete 失败/请求取消 | receipt 持久化不能单纯依赖已取消的请求 context；可用保留上下文值的有界 detached context 或可靠 reconciliation。仍失败须公开 created knowledge ID/可恢复错误，不能完整成功，重试不得再建文档 |
| 过期候选查询后被 import 领取 | 当前 Sweep 查询/文件删除分离，ClaimForImport SQL 未检查 payload deadline。用原子清理领取或严格拒绝过期领取并证明边界；模拟候选查询后 claim 的竞态，不能删除活跃导入的 bytes |
| 文件删除失败 | 不吞 `removeAllQuiet` 错误，不无条件 removed++；错误可观察、可重试，成功计数等于真实成功删除 |
| 待清理记录查询失败 | 立即停止相关清理，不能继续删除 receipt，避免无法确认 payload 情况时丢掉恢复记录 |
| 回执保留期限到但 lease 活跃 | SQL receipt 删除必须排除活跃导入租约；不能影响运行中的导入 |
| 崩溃遗留 importing | 当前可能永久保留 bytes；明确有界恢复/保留期限，期限内可恢复，过界且无活跃 lease 才清理 |

复用已有 hash 重放、CORS、scheduler、上传迁移回归；不删除数据库/队列，不另建 Agent 侧任务平台。

### P1-1：协议、权限和现有页面验收（原任务 B/C）

- 原生 SDK 独立 `tools/list` / `tools/call`；不用 LLM 工具选择结果代替协议验证。
- 13 个只读工具：`list_knowledge_bases`、`list_documents`、`search_knowledge`、`grep_chunks`、`read_document`、`wiki_index`、`wiki_search`、`wiki_read_page`、`wiki_list_pages`、`wiki_graph`、`query_knowledge_graph`、`get_document_status`、`get_knowledge_base_status`。
- 请求四头：`Authorization: Bearer <endpoint token>`、`X-WeKnora-User-Token`、`X-Tenant-ID`、`X-WeKnora-Knowledge-Base-Ids`。不能把 endpoint token 当用户身份。
- 确认端点配置范围、调用者授权范围、请求选择范围的交集；document、Wiki refs、graph refs 都要一致。缺用户 token、错误 workspace、范围外 ID、未知 ID、已撤销权限要有稳定错误且无资料泄漏。
- 写权限先对照 REST 的实际 owner/admin/member/viewer/shared-editor 规则。当前 upload/import 有单独 ownership gate，共享 KB editor 是否被误拒需要核对；不能凭统一 owner-only 假设扩大所有写操作限制。沿用用户原有权限语义。
- 回归 CORS 两个新增请求头及 scheduler 启停；禁止把 graph 未配置/未生成错误算正向成功。
- 业务 UI 使用原 `18180` 页面。当前仅确认能打开登录页、源码已有上传/状态/Wiki/图谱相关入口，**未完成 UI 登录后的上传/问答/来源浏览验收**。
- 确认 UI 的 Wiki graph 与实体查询结果展示分别可用。源码中现有 `graph` tab 主要是 WikiBrowser 链接图，不应凭名称认定 Neo4j 实体图也已展示；先检查现有聊天工具结果/原文展示，再决定必要的最小补齐。
- UI 镜像是发布版 v0.8.2；若改 frontend 源码必须构建匹配 UI 镜像才能验收，否则源码修改不会出现在当前页面。

建议完善现有 `scripts/mcp_smoke.py` 或新增 `verify_core.py`：记录所有工具 schema/成功与失败、原始返回、真实 Wiki/Neo4j 和来源回读；就绪检查依据实际状态/截止时间。空结果、unknown、部分故障都不能自动通过。临时 probe 没有这些通过断言。

### P0-5：离线评估只用真实结构化证据（原任务 F）

修改 `examples/mcp-validation/scripts/run_eval.py`、`recompute_found.py`、`score_eval.py`、`seed_review.py`；新增 `evidence_records.py` 与回归测试。所有证据加工均留在 WeKnora 离线目录。

当前已保存 12 条 `raw_events`，search ToolMessage 的真实 payload 在：

```text
event.type = tool
event.status = success
event.artifact.structured_content.results[]
  knowledge_id, knowledge_base_id, chunk_id, chunk_index, content, ...
```

任务要求：

1. 从实际成功 ToolMessage 的明确 schema 抽取，不从最终答案、全局 UUID 正则或标注语料猜归属。工具错误不计证据。
2. search/grep 的 results 直接读取；read_document 从真实 chunks 和文档 ID 读取；Wiki/graph 按自己 schema 读取 refs/quote/原文。不写泛化递归扫描器把任意元数据当证据。
3. 区分 `discovered_documents` 与 `read_evidence`。列表、状态、Wiki 只有 source ID 的返回可以表示发现，不能表示已读到支持证据，更不能枚举全部文档就算全部检索命中。
4. 用固定版本 manifest 的真实 knowledge ID 映射 logical_doc_id。无法归属的文本记 unattributed；同句出现在两份本地资料时不能凭同句把两份都记为找到。
5. 当前 `derive_tool_evidence` 用 required_evidence 前 20 字匹配并反推文档，必须移除。完整性需在正确文档/必要 chunk 上匹配完整标注 quote，不能后半句不同仍命中。
6. 题库增量增加 `evidence_annotations_v2: [{logical_doc_id, quote, chunk_ids?}]`，保留旧 required_evidence 兼容历史。跨 chunk 拼接仅同一文档按实际顺序，不跨文档拼凑。
7. `recompute_found` 与新运行共用一套来源解析，但保留 tool_call_id；现函数重建 tool_calls 时会丢该字段。旧记录不足时明确 unknown，不补造来源。
8. 新 record 最少包含 tool_call_id、tool_name、knowledge_base_id、knowledge_id、chunk_id、text、read_state。事实支持是另一个核验维度，quote 字面匹配只是辅助。
9. 增加 `tests/conftest.py` 设置本目录 scripts 路径，避免 WeKnora 根同名 scripts 包导入混淆。

必须先写的回归：同句不虚增第二文档；error artifact 不计证据；最终答案虚构 doc02 不加召回；Wiki ID-only 不加证据率；完整 quote 未返回不命中；artifact 真实来源可统计，即使文本没有 ID；来源未知不凭标注补造。

**先复制旧 runs 到新输出目录，再离线重算，不覆盖历史原始轨迹；无需为修评分重新调用模型。**

### P1-2：基线比较、状态分类和人工指标（原任务 G）

- `--strategy baseline|agent|both`。基线＝单次 hybrid top-10 + 一次模型资料问答；Agent＝标准自主工具调用。两者相同模型、用户、KB、题库、temperature=0。
- CLI 当前 model timeout=60、whole timeout=120、recursion_limit=20；run_eval 仍 model=120/whole=180。统一配置，可在 Agent `main.py` 提取短小的标准模型初始化函数复用，不新增业务/运行框架。
- 总超时覆盖工具发现/运行/工具调用。保存原生 messages/events；失败尽量保留已发生的工具消息，不为采集增加生产工具包装器。
- 记录 strategy、配置指纹（不得包含密钥）、运行版本、`run_status=success|timeout|tool_error|model_error|config_error`。失败题保留分母，不能把 `[ERROR]` 字符串当唯一错误分类。
- 当前无答案评分错误：无 hit_evidence 且无 tool_error 就算诚实，无答案标注为空时连虚构“预算100亿元”也可通过。删除此自动通过规则。
- 未人工复核：`refusal_status=not_evaluated`。只有 reviewed=true、运行成功、refusal_supported=true、fabricated_content=false、fabricated_citation=false 才算通过；字段可为 null，缺字段不猜 true。
- 同时检查事实准确性、必要事实完整性、引用支持率，输出分子/分母和未复核数。AI 辅助审查必须标注 reviewer_kind，不能写成真人 reviewed=true。
- 现有人工复核仍是 **0/12**。这意味着准确性尚未验收；其他模型也不能自行伪造人工完成。
- 补单独边界题组：多页原文、超过 top-K、重复片段文档、来源未知、知识冲突、Wiki/graph 未生成、越权、超时、空答案。
- 对缺少 baseline 和 Wiki/graph 自主调用证据的场景补运行；保存新目录，旧十二条数据不自动升级成新策略结果。

首轮原型门槛：可回答题文档 recall 宏平均≥90%，全部找齐至少8/10，必需证据 recall≥90%，人工事实准确率≥95%，事实完整率≥90%，引用支持率≥95%，无答案人工确认2/2，权限边界全部通过。缺人工复核只能报告未验收，不宣称整体通过。

### P1-3：统一文档、镜像和交付口径（原任务 H）

- 更新验证目录 README：它还含“脚本仅在归档/后续评估”的过时描述，当前已有 import/run_eval/score 等脚本。
- 更新 `eval/reports/delivery.md` / `report.md`，旧报告标历史；整理旧0.8/新1.0重复指标，按新来源定义生成一份当前表。
- 区分“源码修复”“回归通过”“真实链路通过”“人工准确性已复核”四种状态。不能只因六包基线通过就勾新缺陷已解决。
- 保留实际工具结果、语料/题库/脚本版本、服务镜像版本和限制；报告不包含密码/JWT/endpoint token。
- 确认 Agent 无 Web 的结构测试仍通过；验证目录业务代码没有流回 Agent。

## 5. 验证命令和交付顺序

当前保留了一个只用于检查的容器：`WeKnoraAgent-correction-check`，镜像 `weknora-agent-check:local`，挂载 WeKnora 到 `/review-src`（只读），工作目录 `/review-src`，已缓存下载/编译，主进程 sleep infinity，无开放端口。可直接用于增量 Go 检查；停止/删除它会丢本轮容器内缓存，不影响业务数据。

先审查/格式化待完成测试，再分别确认失败。下面命令不会实现修复：

```powershell
Set-Location E:\GoLandCode\WeKnora
docker exec WeKnoraAgent-correction-check go test -tags sqlite_fts5 -count=1 -run '^TestDocumentStatusBeforeProcessingHasNoTimestamp$' ./internal/mcpserver
docker exec WeKnoraAgent-correction-check go test -tags sqlite_fts5 -count=1 -run '^TestKBStatusRequiresEveryCounter$' ./internal/mcpserver
docker exec WeKnoraAgent-correction-check go test -tags sqlite_fts5 -count=1 -run '^TestGraphSourcesVerifyEachChunkAndBinding$' ./internal/mcpserver
```

修复后跑必要 Go 包；新增故障再扩大检查，不重复无关全量：

```powershell
docker exec WeKnoraAgent-correction-check go test -tags sqlite_fts5 -count=1 ./internal/mcpserver ./internal/middleware ./internal/router ./internal/types ./internal/application/repository ./internal/application/repository/retriever/neo4j ./internal/application/service ./internal/agent/tools
```

若 helper 不存在，使用验证目录 Compose 的 check target（Linux CGO/SQLite）。不要在 Windows CGO关闭的环境把 SQLite 报错当服务逻辑失败。

分别在两个 cwd 运行 Python 测试，不混合两个同名 tests 包：

```powershell
Set-Location E:\GoLandCode\WeKnora-Agent
.\.venv\Scripts\python.exe -m pytest tests -q
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe main.py --help

Set-Location E:\GoLandCode\WeKnora
& E:\GoLandCode\WeKnora-Agent\.venv\Scripts\python.exe -m pytest examples/mcp-validation/tests -q
```

Go 修复测试通过后才重建/重启知识服务，让真实验证运行新二进制，保留数据卷：

```powershell
Set-Location E:\GoLandCode\WeKnora\examples\mcp-validation
$composeArgs = @('-p', 'weknora-agent-prototype', '-f', 'deploy/compose.prototype.yml', '--env-file', 'deploy/.env.prototype')
docker compose @composeArgs config --quiet
docker compose @composeArgs build weknora
docker compose @composeArgs up -d --no-deps weknora
```

业务 UI 不需要重建，除非确实修改其源码；届时须明确构建/配置对应镜像。禁止 `down -v`。

再按顺序完成：原生 SDK 13 工具/权限 → 真实 Wiki/Neo4j 与来源回读 → 原业务 UI 上传/问答 → 单个纯 Agent CLI → 旧轨迹离线重算 → 新策略/缺失场景评估 → 人工复核模板与诚实报告。

新评估命令在实现 `--strategy` 后才能使用，当前直接执行会失败：

```powershell
& E:\GoLandCode\WeKnora-Agent\.venv\Scripts\python.exe scripts/run_eval.py --agent-dir E:\GoLandCode\WeKnora-Agent --manifest eval/corpus/manifest.json --questions eval/questions/demo-12.json --strategy both --output-dir eval/reports/correction-current
```

交付前 `git diff --check`，审查两仓库变动，只提交本次明确文件；不要提交 secrets、诊断目录或用户原有未跟踪文件，不推送/发布无授权内容。最后可清理本轮 check helper，保留业务容器/数据和验收证据。

## 6. 可直接发给下一模型的执行指令

```text
读取 E:/GoLandCode/WeKnora-Agent/docs/remaining-work-handoff-2026-10-14.md，按它续做，不从旧方案的历史状态重新开工。
用户确认：业务使用WeKnora现有问答，WeKnora-Agent只是纯LangChain/MCP验证客户端。
Agent裁剪已提交cefb0af并通过16项测试及双审查，不重建Web/自动登录；主要剩余工作在WeKnora。
WeKnora基线d68b0f47c已包含R1–R14，应保留；交接时只有两组未运行/未格式化的新回归和gitignore，本轮尚未新增生产Go修复。先核对当前目录/HEAD/diff；后来新增改动也默认保留审查，不回滚重做。
先跑nil ProcessedAt、计数known、逐chunk图谱来源失败用例，然后修Wiki授权来源、上传并发/回执/清理恢复。
真实隔离KB已生成8页Wiki、两条Neo4j关系，配置/原始结果位置见交接文档；复用资料但服务修改后重新验收，禁止清库/删卷。
评估只读ToolMessage artifact.structured_content的真实来源，去掉前20字/标注反推、无答案自动通过；补baseline/agent比较与统一运行配置。
实际UI闭环和人工准确性仍未完成，人工0/12不能写通过；AI辅助不能伪造真人复核。
最终交付代码、必要回归、真实工具结果、明确未完成项和当前报告。不要向我只回复计划，按上述要求实施。
```
