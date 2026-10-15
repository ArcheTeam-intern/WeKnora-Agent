# 验收执行记录 2026-10-15（MCP 工作台收尾）

> 按 `docs/superpowers/plans/2026-10-15-mcp-workbench-handoff.md` 任务 0–9 执行。
> 本文件不含任何 Token、密码、密钥或端点凭据。

## 任务 0：基线

### 仓库

| 仓库 | HEAD | 分支 |
|---|---|---|
| WeKnora | `c43b5fb66` | `codex/mcp-prototype-correction` |
| WeKnora-Agent | `450dde8` | `codex/mcp-prototype-correction` |

两仓库均有大量**未提交**改动（含此前其他模型的实现），逐文件清单见执行会话；未执行任何回滚、清理或批量暂存。

### 运行环境（执行开始时）

- 容器（已按新命名运行，全部健康）：`WeKnoraMCP-app`、`WeKnoraMCP-docreader`、`WeKnoraMCP-ui`、`WeKnoraMCP-redis`、`WeKnoraMCP-neo4j`；另有 WeKnora 构建测试辅助容器 `WeKnoraAgent-correction-check`（非 Agent 数据依赖）。
- 端口：WeKnora 服务 `127.0.0.1:18082`（health 200）、WeKnora UI `127.0.0.1:18180`（200）、工作台 `127.0.0.1:18100`（200）。
- 工作台进程：启动于 10:41（PID 37076/39324），**早于**最新源码（webapp.py 10:54、app.js/session.js 10:53），按交接要求重启后再验收。

### 环境变量名称（仅名称与用途，不记录值）

- 模型：`AGENT_MODEL`、`AGENT_MODEL_BASE_URL`、`AGENT_MODEL_API_KEY`
- 端点：`WEKNORA_MCP_URL`、`WEKNORA_MCP_TOKEN`
- CLI 用户身份：`WEKNORA_USER_TOKEN`、`WEKNORA_WORKSPACE_ID`（live 测试另读 `WEKNORA_TENANT_ID`，取同一工作空间）
- 工作台：`WEKNORA_AGENT_WEB_PORT`、`WEKNORA_AGENT_ENDPOINT_ID`

## 任务 1：Token 工作流（通过）

- 独立凭证工具 `examples/mcp-validation/scripts/issue_user_token.py`：实况签发出凭证文件（`deploy/workbench-user-token.local.json`），合同形状 `{profile{email,name,user_id,tenant_id}, token, expires_at}` 正确；输出不打印 Token。
- 测试：`examples/mcp-validation/tests/test_issue_user_token.py` 18 passed；Agent `tests/test_webapp_routes.py tests/test_agent.py` 40 passed；`node --test tests/test_token_session.js` 6 passed。
- 错误分类（实况）：有效 Token → MCP `list_knowledge_bases` 200/3 个知识库；篡改签名 → 401 且 `error_code=UNAUTHORIZED`；错误工作空间 → 业务错误（ok:false）而非自动登录；无身份请求 → 400（不存在 env 身份回退）。
- 失效路径：401 清除 sessionStorage 中的凭证（刷新不复活）；`canInvalidate` 保证旧 Token 的迟到 401 不删除替换后的新 Token；Token 字段为密码输入；轨迹经 `TokenSession.redact` 脱敏。

## 任务 2：身份切换旧响应隔离（通过）

- 新增 `web/assets/app.js` 身份 epoch（`capture/isCurrent/advance`），连接、切换、断开、401 失效统一推进；所有异步入口（ask/agent 的 SSE 回调与 finally、上传/导入/写工具、清单 step/done、工具台、KB/工具/端点刷新、`api()`/`sse()` 本身）在写状态或 DOM 前检查 epoch；身份变化同时清空 KB/工具/选择/轨迹并重建视图。
- 新增 `tests/test_identity_lifecycle.js`（vm + 最小 fake DOM/fetch 驱动真实 app/views 代码）8 例：迟到回答不写回且不泄漏 session、迟到上传回执、迟到导入、迟到清单、迟到工具结果、迟到 KB 列表、401 失效推进 epoch、迟到 401 不废除新 Token。
- 结果：`node --test tests/test_token_session.js tests/test_identity_lifecycle.js` = 14 passed / 0 failed；`node --check` 三个资源文件通过；静态资源版本号升至 `20261015-2`。
- 待办：真实页面"延迟响应"手测（放到任务 7 的浏览器验收中执行）。

## 任务 3：上传首次并发幂等恢复（通过）

- 删除恒真判断 `recoverFromUniqueKeyConflict`；新增仓储层分类 `IsIdempotencyKeyConflict`：只认本幂等索引（PostgreSQL 约束名 / SQLite 精确四列组合，含真实迁移索引回归），锁超时、主键冲突与断连一律透传。
- `Stage()` 恢复路径改为：仅索引冲突才重读 winner；同 KB/文件名/大小/SHA256 → 返回 winner 且 `replay=true`；否则同一 `IDEMPOTENCY_CONFLICT` 形状；winner 不可读时保留原始数据库错误；失败路径清理 loser 暂存目录。
- 新增测试：barrier 确定性并发（同键同字节 → 同 upload_id、恰一 replay、仅 1 个暂存目录；同键异字节 → 冲突且 winner 不被覆盖）、错误透传（锁/断连/主键冲突/无 winner/已有 winner 时锁错误）、空键并发、真实 SQLite 分类回归。
- RED/GREEN：修复前两例失败（同键同字节被误判冲突、锁错误被伪装成冲突），修复后全部通过。

## 任务 6：模型生成超时（已定位并修复）

证据链（全部可复现）：

1. 应用日志：`[LLM Request] endpoint=https://api.deepseek.com/v1/chat/completions, model=deepseek-flash` 之后 240s 无任何响应，`read response: context deadline exceeded`；另一次 SSE 请求同样卡到 75s 被取消。
2. 排除模型名：宿主机直连 `deepseek-chat` 1.48s 返回 200（响应规范名即 deepseek-flash）。
3. 排除容器出网：容器内 GET/POST 各 8/8 稳定（≤0.2s），容器内用同一密钥真实生成 0.47s 成功。
4. 同一时刻应用自身调用有时 0.6s 成功、有时挂满 240s → 间歇性，与 keep-alive 连接被本机代理静默丢弃的模式一致（Go 对带 body 的 POST 在死连接上不自动重试，而共享 HTTP 客户端没有 ResponseHeaderTimeout）。

修复（`internal/models/api/transport.go` + `endpoint.go`）：
- `ResponseHeaderTimeout=60s`（首个响应字节的等待上限，超时转快速错误）；
- `IdleConnTimeout` 90s→30s（在被中间设备丢弃前退休空闲连接）；
- `Endpoint.Do` 对“超时类”传输失败在新连接重试一次（带 `GetBody` 且调用方 ctx 未结束；非 2xx 与其它传输错误不重试）。

验证：新增 4 个单测通过；`go test ./internal/models/api/` 通过；连续 6 次 MCP `ask` 全部成功（1.3–2.1s）。

Agent 侧另一处配置错配同时修复：`.env` 原先指向 MiniMax 的 **Anthropic 协议端点**（`https://api.minimaxi.com/anthropic`），但代码用 OpenAI 协议客户端（实测该路径 404）；改为 `https://api.minimaxi.com/v1` 后 `main.py` 真实问答成功。`.env` 中过期的用户 JWT 已用 `issue_user_token.py` 重新签发（新 expires_at 2026-10-16T05:15:45Z）。

## 额外修复（用户反馈）

- **页面无法上下滚动**：`.content` 作为列 flex 子项默认 `min-height:auto`，被内容撑到 1159px（视口 720px），而 `body{overflow:hidden}` 裁剪溢出 → 完全无法滚动。修复：`.main`/`.content` 增加 `min-height:0`。实测 `clientHeight=594 / scrollHeight=1404`，`scrollTop` 可达，静态资源版本升至 `20261015-3`。

## 用户反馈：demo 里的凭证获取要“简单快速”（已交付）

在保持既有边界的前提下（工作台不做登录代理、不存密码、不自动续期；不新建第二套签发器），新增两层便捷入口：

- `scripts/refresh-credential.ps1`（Agent 仓）：一条命令，内部调用 WeKnora 官方 `issue_user_token.py` 完成正式登录，随后把新 JWT 同步进 `.env`（供 CLI）并保留标准位置的凭证文件（供工作台）。以 UTF-8 **with BOM** 保存（PowerShell 5.1 否则按 ANSI 误读中文脚本）——实测签发+同步成功、`.env` 首行未被 BOM 破坏。
- `webapp.py` 新增 `GET /api/local-credential`：只读取官方工具写下的凭证文件（环境变量 `WEKNORA_CREDENTIAL_FILE` 可覆盖路径）；文件缺失时返回明确提示。工作台弹窗新增「🔄 读取本机凭证」一键按钮，读取后仍需「连接工作台」经 MCP 校验才生效。
- 边界测试保持通过（三份运行时文件仍不含 `accounts.json` / `/api/v1/` 等禁止串）；新增 3 个路由测试；README 更新为两步流程。
- 浏览器实测：读取 → 自动填账号/工作空间/Token → 连接成功（`已连接 · 10/16 到期`，3 个知识库、20 个工具）。全量测试：pytest 54 passed / 1 skipped，Node 14 passed。

## 任务 4/5/7/8/9：结果

### 任务 4（上传/导入/清单）与任务 5（问答双模）

- 上传双通道（默认 `upload_file` 工具通道 + multipart 文件流通道）实测均可用；回执显示 upload_id/file/size/sha256/expires 与幂等重放标记。
- 导入后自动跑验证清单：按 KB `capability_flags` 门控，失败带原始响应，跳过永远带原因；清单可下载 JSON。
- 问答双模：原生 `ask`（默认，带 session 续问 + references 卡片）与 LangChain agent 模式并存，二者共用同一条 MCP 身份头。

### 任务 7（浏览器验收）与任务 8/9（收尾）

- 浏览器实测：页面可滚动（`clientHeight=594 / scrollHeight=1404`）、KB/工具数正确（3 库 / 21 工具）、上传→导入→清单→问答全链路可用。
- 任务 8/9 的交付物与提交见下文「复核整改」与「全工具实测」。

## 复核整改（P0-1/P0-2/P0-3/P1-1/P1-2，2026-10-15 下午）

复核意见：<本仓 `docs/current-implementation-review-2026-10-14.md` 的四点差距 + 用户转述的工作单>。

### P0-1 上传目标与问答范围分离（已改）

- 顶栏改为**只读**范围摘要（`#scope-summary`）：不再与任何页面的选择器隐式同步。
- 资料页新增**上传目标知识库**下拉（`S.uploadTargetKbId`），上传/导入/状态查询只带该库的 `X-WeKnora-Knowledge-Base-Ids`。
- 问答页改为**多选范围 chips + 「全部可用」**（`S.qaKbIds` / `S.qaScopeAll`）；未选择任何范围时发送按钮禁用并给出提示。
- 问答范围或原生模式变化 → `advanceQaEpoch()`：开启新会话、清空消息、丢弃旧范围/旧模式的在途回答。
- Node 生命周期测试新增 2 例（范围变化开新会话且丢弃旧答案、未选范围禁用发送），`tests/test_identity_lifecycle.js` 16 passed。

### P0-2 解析引擎贯通（已改）

- 新增工具 `list_parser_engines`（工具数 20 → 21）：返回部署真实的解析引擎目录（名称、支持类型、可用性、不可用原因、docreader 连接态），只暴露安全字段。
- `import_document_file` 新增 `process_config`（`parser_engine_rules`）；Go 侧严格校验（`DisallowUnknownFields`、引擎必须存在且可用、文件类型去点规范化去重、不支持的类型拒绝），随后写入 knowledge 元数据 `process_overrides`。
- 管线记录**实际执行的引擎**：`internal/application/service/knowledge_process.go` 在解析前 `SetAppliedParserEngine`；`get_document_status` 回显 `requested_parser_engine_rules` + `applied_parser_engine`；资料页状态行显示「请求引擎 / 实际引擎」。
- 幂等重放路径不再假装应用了新配置：回执带 `process_config_applied:false` 与明确说明（重放不重新解析）。

### P0-3 原生问答模式（已改）

- `ask` 新增 `mode`（`quick-answer` / `smart-reasoning`），映射到内置 agent；未知模式在服务端拒绝；响应回显 `mode` 与 `knowledge_base_ids`。问答页提供分段选择 + 独立的多步推理开关（LangChain agent），两者互不伪装。

### P1-1 首包超时重试（真实缺陷，已修）

复核指出前一版重试判据把 `context.DeadlineExceeded` 排除在外，而 Go 恰好用它表达 `ResponseHeaderTimeout`——等于真正的首包超时永不重试。已改为仅依赖 `req.GetBody != nil && req.Context().Err() == nil && 超时类错误`。新增 7 个测试含**真实 httptest 服务器**：50ms 首包超时 + 服务端睡 400ms → 恰好 2 次尝试且请求体一致。`go test ./internal/models/api/...` 全绿。

### P1-2 本机凭证端点加固（已改）

- `WEKNORA_CREDENTIAL_FILE` 改为**显式 opt-in**（无默认路径）；未设置时返回 404 + 配置提示。
- Host 白名单（仅本机名/回环，非本机 403）、Origin 校验、`Cache-Control: no-store`、响应体不回显读取路径。
- 新增 6 个路由测试；`pytest` 60 passed / 1 skipped。

## 解析引擎端到端证明（唯一文档，非去重结果）

复核要求「不要用同一 PDF 的去重结果证明另一解析引擎已重新处理」。因此生成一份**一次性唯一文档**（772 字节单页 PDF，run id `dc3a434481`，sha256 `7ed763828a49e6cd…`），在浏览器页面上选择引擎 `anydoc` 后上传并导入到库 A：

| 证据 | 值 |
|---|---|
| upload_id | `b26401d7-d48b-4d50-afb9-513101ffb443` |
| document_id | `77a8fa9c-c210-435f-9953-c1e551fcffae`（`deduplicated=false`） |
| 导入回执 | `已入队（queued=true dedup=false · 解析选项已提交）` |
| 请求引擎（服务端） | `requested_parser_engine_rules=[{file_types:[pdf],engine:anydoc}]` |
| 实际引擎（服务端） | `applied_parser_engine="anydoc"` |
| 状态 | `parse_status=completed`、`index_status=completed`（2026-10-15T17:49:15+08:00） |
| 内容可检索 | `grep_chunks DC3A434481` → 2 命中，正文为探针 PDF 原文 |

即：请求的引擎确实进入管线并被执行（不是默认 `builtin`，也不是去重复用）。同一文档保留在库 A 供人工复核；不需要时可从工作台「开发诊断」页用 `delete_document` 删除。

## MCP 全工具实测（live，23 行 PASS / 0 skip / 0 fail）

`WEKNORA_LIVE_MCP=1 pytest tests/test_live_mcp_tools.py -q -s`，走与控制台**完全相同**的 raw JSON-RPC 路径、用户模式身份头，目标库为显式指定的验收库：

```
PASS  list_knowledge_bases       visible_kbs=3
PASS  list_parser_engines        engines=10 available=5 docreader_connected=True
PASS  list_documents             total=9 completed=9
PASS  get_document_status        parse=completed index=completed
PASS  read_document              truncated_field=True
PASS  search_knowledge           hits=2
PASS  grep_chunks                hits=0
PASS  ask                        answer_chars=819 refs=5
PASS  get_knowledge_base_status  docs=9 chunks=242 counts_known=True wiki=available graph=available
PASS  wiki_index / wiki_list_pages / wiki_graph / wiki_search / wiki_read_page
PASS  query_knowledge_graph      relations=0
PASS  upload_file                upload_id=77b21b09…
PASS  get_upload_status          state=staged
PASS  import_document_file       document_id=141dcce4… deduplicated=False
PASS  import process_config      requested=['simple'] applied=simple
PASS  add_document / update_document / delete_document（草稿自清 x2）
合计：pass=23 skip=0 fail=0（耗时 8s）
```

本轮新增的两行是关键：`list_parser_engines` 覆盖第 21 个工具；`import process_config` 用**非默认**引擎（`simple`，服务端目录里声明支持 md 的可用引擎）验证「请求 → 实际执行」闭环。写类工具一律先创建本轮唯一 uuid 草稿再删除，dedup 命中的文档不删。

## 验收矩阵（用户指定的三步）

| 步骤 | 操作 | 结果 |
|---|---|---|
| 1 | 把 `WeKnora-PDF验收样本-青岚计划.pdf` 上传到库 A（`MCP纠偏核心验收-20261014`）并导入 | upload_id `9257711c-8418-48f9-8936-b1c6ffd67d03`，document `863e8adf-ba69-41c8-bac2-e550f7cf0b6d`，解析 84s，`applied_parser_engine=default` |
| 2 | 在问答页按 PDF 最后一页提问 Q1/Q3/Q4/Q7/Q8 | 四问均与标准答案一致（Q7 为扫描页 OCR 生效项） |
| 3 | 切到**未上传该文件**的库 B + 新建会话，重复 Q1 | 回答明确表示资料不足，未编造；引用为空 |
| 4 | 切回库 A，重复 Q1 | 回答恢复正确并带引用 |

标准答案文件 `E:\GoLandCode\WeKnora\output\pdf\测试问题与预期答案-不要上传.md` 全程未上传、未进任何库或附件。

## 说明

- 本文档不含 Token、密码、密钥或端点凭据；`.env` 与凭证文件均未入库。
- 前端静态资源版本 `20261015-6`；页面结构：资料解析（上传目标 + 解析引擎）、知识问答（范围多选 + 原生模式/多步推理）、开发诊断（工具台 + 验证清单 + 增改删）。
## 第二轮复核整改（同日稍晚，用户反馈）

| 反馈 | 处理 |
|---|---|
| 第二个 PDF 上传报 `IDEMPOTENCY_CONFLICT` | 页面一生只生成一次上传标识，换文件仍沿用 → 改为换文件/换目标库自动换新标识（手改过则不覆盖），命中冲突再自动重试一次；multipart 通道不再吞掉上游错误正文。两条 Node 回归测试 |
| 导入后看不到进度；刷新就全没了 | 导入后显示进度面板（等待秒数、解析/索引中文状态、请求与实际引擎、最后更新），解析完成给出分块数与原文预览；上次上传/导入按身份存 sessionStorage，刷新自动恢复并续看；另加「查看知识库最近导入」兜底。两条 Node 回归测试 |
| MCP 轨迹与开发诊断太英文、不好演示 | 轨迹抽屉与诊断页加中文层（工具中文名/字段中文名/中文结论与错误原因），英文契约保留在折叠区与 path 行 |
| 每个 MCP 工具要有「真能查到」的示例 | 22 个工具全部支持「填入示例」：参数用当前真实状态（目标知识库、最近文档 id、最近 upload_id、文档标题词）自动填好并说明预期结果 |
| 不能新建知识库 | WeKnora 新增 MCP 工具 `create_knowledge_base`（Contributor+ 或被授予 ingest 能力的端点可用；web 用户创建的知识库归属本人；受限端点自动把新库加入自身范围）。控制台资料页加「＋ 新建知识库」 |
| LangChain 验证链是什么 / 不需要就不要 | 控制台问答页移除 LangChain 入口，只保留 WeKnora 原生 `ask`（`quick-answer` / `smart-reasoning`）；仓库里的 CLI Agent 仍可用，但控制台不再内置第三方编排 |
| 写工具与工具目录重复 | 删除重复的写工具卡片，写操作统一在工具目录里跑（带二次确认与示例） |

实测：界面新建知识库成功并自动选中（toast + 列表刷新）；`get_document_status` 的示例自动填入最近文档 id `9bcd6223…` 并成功返回真实状态；问答页选范围后提问返回「林澈」及 `chunk f65bab05…` 引用。验证用的两个演示库已删除，端点范围恢复为原三库、工具数 22。

## 第三轮（演示准备）：示例问题、能力感知示例、可用的全能力演示库

- 问答页新增 5 条示例问题（点一下即填入），覆盖文字页/表格页/扫描页，配套《WeKnora-PDF验收样本-青岚计划》。
- 图谱/Wiki 工具报 `GRAPH_EXTRACTION_NOT_CONFIGURED` 不是工具坏了，是当时选中的库没开该能力。工具示例现在会**自动挑一个已开启该能力的库**（优先当前上传目标），失败时也会列出哪些库可用。
- 新建了演示库 **演示库-问答Wiki图谱**（`3daf893b…`）：开启 Wiki + 知识图谱 + OCR，模型继承工作区默认（embedding `c7dd10c9…`、QA `0142cc52…`、VLM `7d5d6380…`），内含验收 PDF（doc `3930c19c…`）。实测：解析/索引/摘要 completed，7 个分块、Wiki 13 页 15 链接、图谱 `query_knowledge_graph` 返回 7 条关系。
- 起因是两个真实缺陷（已修，见 WeKnora commit）：MCP 建的库不带 embedding/summary/VLM 模型 → 首次导入必然 "model ID cannot be empty"；图谱开启但没配实体/关系类型 → 抽不出任何关系。

## 第四轮：图谱"开了但没配类型"的澄清与修复

用户建库时把 Wiki 与图谱都勾了，Wiki 正常但图谱查询报 `GRAPH_EXTRACTION_NOT_CONFIGURED`，而提示里又把该库列为"已开启图谱"。

- 根因：`capability_flags.graph` 只反映"开关打开"，而 `query_knowledge_graph` 还要求**配置了实体/关系类型**（`graphKnowledgeBases` 会过滤掉类型为空的库）。两边口径不一致。
- WeKnora 侧修复：`list_knowledge_bases` 新增 `graph_ready`（开关 + 至少一种实体/关系），图谱查询在"开了但没类型"时给出专门提示（说明该库 `graph_ready=false`、要配类型），不再笼统说"没有开启图谱的库"。
- 控制台侧修复：新建知识库的弹窗在勾选图谱时**要求填写实体类型与关系**（预填了一套可直接用的示例：人员/项目/服务/批次 + 负责/复核/依赖/属于），避免再建出"开了也抽不出"的库；工具提示改看 `graph_ready`。
- 用户已建的 `aaaa`（id `4975152c…`）保留：图谱类型需通过产品接口 `PUT /initialization/config/:kbId` 的 `nodeExtract` 配置，且**已入库的文档不会自动补抽**，需重新导入。演示时建议直接用已配好的《演示库-问答Wiki图谱》。
