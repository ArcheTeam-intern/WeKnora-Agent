# 当前实现审查：独立 MCP 客户端与上传、解析、问答

日期：2026-10-14。审查当前工作区，WeKnora HEAD 为 `d68b0f47c`，WeKnora-Agent HEAD 为 `cefb0af`；另一个模型的改动多数尚未提交。本文是审查快照，不代表后续新增改动。此次未修改生产代码、端点权限、秘密配置或部署，未创建新文档。

## 1. 结论

**尚未达到预期。** 现有 CLI 的标准 LangChain/MCP 检索问答结构保留，WeKnora 业务管线也有实际进展；但“独立 Agent 仅通过 MCP 完成上传→解析完成→问答”的入口和验收没有闭环。

按用户最新要求，区分两条调用路径：

- **CLI**：`main.py → build_agent → 标准 MCP → LangChain 问答`，没有业务 REST 登录。它目前只有 question 入口，模型工具名单保持只读，不能由此执行文件上传/导入。
- **新增 Web**：`webapp.py → REST 邮箱密码登录 → 缓存身份/Agent → MCP`。新增上传/导入接口意图使用 MCP，但存在返回协议错误，页面尚未接入，实际 MCP 端点也未开放 upload_file。

此前约定是 Agent 只保留标准框架与 MCP 配置，不建设另一个 Web/身份应用；当前又恢复 webapp.py/web 和直接 Web 依赖。若后续明确保留独立演示页面，应把它视为新的展示范围并保持薄客户端，不以它证明此前纯结构要求已通过。

## 2. 已验证的正向进展

- Agent `main.py` / `agent.py` 仍使用 ChatOpenAI、MultiServerMCPClient、create_agent；未引入独立文档解析器、检索数据库、Wiki/图谱生成业务。
- WeKnora 新增 `internal/mcpserver/tools_upload.go`，`upload_file` 接受 base64 文件并复用现有 Stage；注册进服务和端点工具目录。这提供了通过 MCP 传文件的实现方向。
- 实际隔离 KB 的 `get_document_status` 返回 completed；KB 有2份文档、4 chunks、8 Wiki pages，pending=0。
- 实际 `wiki_read_page` 返回来自两份文档的7条 V2 refs，均有 quote 并标 verified；相比旧版 ID-only 来源已有改进。
- 实际 `query_knowledge_graph` 返回“负责”“依赖”两条关系和两份原文，来源按 chunk 分条；但 KB 标识仍有缺陷，见第4节。
- 状态源码增加 ProcessedAt nil guard 和统计项 known 检查；Complete 改为有界独立 context；Claim 增 payload deadline 条件，receipt sweep 增 live lease 保护。应保留这些有效修复。

这些结果只证明已有资料的服务查询，不证明新增文件全程走纯 MCP 上传/解析/问答，更不证明最终事实准确率。

## 3. 主流程阻断，优先修复

### A1. Agent 又依赖 WeKnora 身份 REST，范围偏离

位置：`WeKnora-Agent/webapp.py:52–112`、`requirements.txt:8`。

`login_for_token` 调 `/api/v1/auth/login`；ensure_agent 和 ensure_mcp_client 均强制用 DEMO_EMAIL/PASSWORD 登录，再缓存 token/连接/Agent，并在401时重登。即便调用者已经提供有效 MCP 四头，Web 入口仍依赖额外身份 REST 和邮箱密码。

建议：恢复用户提供有效身份配置的边界；客户端知识操作全部调用 MCP。若保留展示层，只做输入/文件选择/原生结果展示，不承担登录代理、身份缓存平台和重试登录策略。

### A2. 实际端点没有开放 upload_file

本轮使用标准 MultiServerMCPClient 原生 tools/list/call，检查两个现有端点：Agent `.env` 指向端点，以及隔离验收端点。

- 前者列出16个工具，后者15个工具，**均没有 upload_file**。
- 无写入的空参数 `upload_file` 调用均返回 `isError=true`、`FORBIDDEN`。
- import_document_file/get_upload_status 已开放，不能代替缺失的文件传输入口。

建议：先在 WeKnora 正确配置必要的 ingest 工具权限，再使用实际用户/KB验证；不在 Agent 增 REST 上传 fallback。本次审查没有修改端点权限。源码已有工具注册不意味着已对当前端点启用。

### A3. 新接口成功路径会返回 HTTP 500

位置：`WeKnora-Agent/webapp.py:209–227`，调用方 upload/import_upload/upload_status/kb_status。

`_mcp_call` 错误路径返回 JSONResponse，成功路径却返回普通 dict。Starlette 路由不会像 FastAPI 那样自动把 dict 转为 Response；调用这些 handler 的成功路径将失败。

已用 Starlette TestClient 验证，替换 `_mcp_call` 为成功 dict，不访问真实服务：

```text
POST /api/import                          500 Internal Server Error
GET  /api/kb_status?knowledge_base_id=...  500 Internal Server Error
```

MCP 可能已经完成远端写入，但页面收到500；这会诱导重试并扩大幂等/恢复问题。若保留这层，返回一致的 Response 并针对成功/失败写回归；如果恢复纯 CLI，直接退出 Web 层。

### A4. 上传和解析没有接入用户入口

位置：`WeKnora-Agent/main.py:59–61`、`agent.py:7–26`、`web/index.html:119–142`。

- CLI 只有 --question / --mcp-config / --env-file，无文件上传/导入入口。
- 问答模型仍使用13工具只读名单，upload_file/import_document_file 被过滤。保持问答只读本身合理，但不能据此声称客户端支持文件导入。
- 页面实际 DOM 只有聊天区、问题输入框、发送按钮；虽然有 toolbar/file 的 CSS，没有对应上传控件，也没有 /api/upload、/api/import、状态查询的前端调用。
- Web 后端只有 upload_status/KB status，没有特定 knowledge_id 的 get_document_status 入口，也没有等待新文件 parse/index ready 的流程。import 返回 document_id/queued 不等于解析完成。

建议：若按最小独立客户端实现，可由显式用户动作通过标准 SDK 确定性调用 upload_file→import_document_file→get_document_status；确认终态后才开始问答。文件 bytes 不送进模型提示词；LangChain 问答继续只读。上传/解析/检索业务实现全部留在 WeKnora。

### A5. 通过的测试已失去原有结构门禁

Agent 当前13项测试通过，但 `tests/test_project_boundary.py` 被删除，原3项门禁不再收集；test_http_mcp 中 uvicorn 禁用断言也被去掉。

本轮从 `cefb0af` 读取原3项断言，在当前目录内存执行，结果：

```text
test_root_production_python_is_only_cli_and_agent              FAIL
test_project_has_no_web_application_directory                 FAIL
test_runtime_requirements_have_no_direct_web_application_packages FAIL
```

建议：保留与最终确认范围相符的门禁。不能通过删测试把违反原范围的实现标为合规；若范围明确调整，应先改验收契约并补新的约束和完整流程回归。

## 4. WeKnora 还需修正的服务问题

| 优先级 | 位置 | 已核对的问题与影响 |
| --- | --- | --- |
| P1 | `tools_upload.go:97–108`；`internal/middleware/logger.go:198` | base64 全量解码后才检查文件大小，MCP 接收层未见 envelope cap；大请求先分配内存再拒绝。JSON content 文件字节还会进入 access log，sanitizer 未处理 content；需要早期体积限制和文件内容日志屏蔽 |
| P2 | `tools_graph.go:272`；`internal/agent/tools/query_knowledge_graph.go:899` | 实际 edge 生产者只有 knowledge_id/chunk_ids，无 knowledge_base_id；新 refs 仅从 edge 取 KB。原生调用实测两条 verified refs 的 knowledge_base_id 都是空字符串 |
| P2 | `tools_graph.go:198–272` | graphChunkIndex 不保存 knowledge_id，核验仅比较 KB，不能识别同 KB 的错误 document/chunk 绑定；授权 KB 参数仍被忽略；单 chunk edgeQuote fallback 也不能替代实际读取核验 |
| P2 | `upload_staging.go:372` | 两个同 key 首次请求都错过查找后，Create 唯一键失败仍直接返回，没有回查赢家回执/比较当前 size/hash；并发幂等恢复未实现完整 |
| P2 | `tools_wiki.go:470` | quoteSnippet 按200字节截断，可能切断中文 UTF-8 字符；JSON 会产生替换字符，破坏原文引文。按合法字符边界截断 |
| P2/P3 | `upload_staging.go:531–559` | 过期查询失败仅记录日志，仍执行 receipt sweep，LivePayloadRecords 失败在变更回执后才发现；不符合 fail-fast 要求。payloadRemovals + payloads 还会重复统计文件删除与状态过期 |

这里的日志风险来自新增 JSON 文件传输路径，不是要求大规模改其他业务日志。清理顺序问题没有在本轮证明会删除活跃租约，不把未证实影响当既定事实。

服务回归不足：新 upload_file 未发现专门测试；Complete 请求取消测试使用忽略 context 的 fake repository，旧实现也可能通过，应增加实际有取消语义的持久化验证。

## 5. 评估与交付报告不能作为已完成证明

评估脚本24项测试通过，但原生返回复现出契约缺口：

```text
read_document: actual_chunks=1，evidence_records解析=0
wiki_read_page: 实际7条带quote来源，evidence_records解析=0
query_knowledge_graph: 结果records解析=4
```

原因：`evidence_records._parse_artifact_results` 只解析 structured_content.results，没有分别处理 read_document.chunks、Wiki.source_refs_v2。当前测试构造的 Wiki fixture 使用 results，和实际服务输出不同。

此外：

- `hit_evidence` 使用完整 record text 严格相等。原文包含 `prefix full quote suffix`，标注 `full quote` 仍未命中；应在正确文档/必要 chunk 上检查完整标注片段覆盖，不能要求等于整个 chunk。
- 未完成带文档锚点的 evidence_annotations_v2；同句在不同文档的支持归属仍需约束。
- run_eval 仍自行 create_agent/初始化模型，未复用标准 build_agent/模型配置；get_tools 在总超时之外。
- ask_agent 改为 ainvoke 结束后才采集 messages；失败/超时前的工具轨迹仍为空，无法核查中断过程。
- verify_core 实际只 tools/list、一个正向 search 和少数拒绝/CORS检查；没有13工具逐一正向调用，也没有上传/解析/问答链路，不应称全部核心验收已过。
- 新 --strategy both 的真实12题未跑，人工仍0/12。这两项交付报告已承认未完成，应保持诚实。
- delivery-2026-10-14-final.md 形成时间早于新增 tools_upload/web 流程，不能把其结果自动覆盖后续改动。

## 6. 建议的最小整改顺序与通过条件

1. 确认并保持独立 MCP 客户端边界：复用标准框架、提供外部身份，移除自动登录职责；展示壳是否保留不改变业务归属。
2. 开放正确 ingest 工具配置，修复客户端成功返回/用户入口/特定文档状态轮询，先跑一个文件的纯 MCP 正向流程。
3. 修新增上传的请求大小/内容日志边界和并发幂等，验证失败重试不会重复建文档。
4. 修 graph 真实 KB/document 绑定与中文 quote 截断，保留已有状态/Wiki回读修复。
5. 使用真实 tools schema 补评估解析和轨迹采集，重算旧轨迹，再补缺失的新模型比较运行；人工未完成不判准确性通过。
6. 交付保存同一文件 SHA、upload_id、knowledge_id、解析/index终态、retrieved chunk ID/正文、最终答案/引用，并记录错误恢复和实际服务镜像版本。不要包含 token/password/file bytes in logs。

通过条件是：调用方凭有效配置，**不需要 WeKnora 的 Python/Go 内部模块，也不需要 Agent 登录代理或 REST 知识业务 API**；标准 MCP 完成上传/导入/状态/检索，LangChain 根据刚导入的实际资料回答并可回读出处。仅注册工具、查询旧资料或单元测试全绿不能替代这个正向流程。

## 7. 本次验证范围

- 当前 Agent 测试：13 passed，pip check 无冲突；旧3项结构断言在当前状态全部失败。
- 当前离线脚本测试：24 passed。
- 标准 SDK 两端点 tools/list、upload_file 无写入拒绝探查；现有资料 status/Wiki/graph/read 正向调用。
- TestClient 成功结果 HTTP500 复现；实际 MCP payload 的评估解析复现。
- 两仓库 git diff --check 通过；没有重跑全量 Go，没有新增样本文档/更改权限/重建镜像，没有重跑真实12题或做人工准确性认证。
- 另有独立只读 Go 代码审查，验证了第4节的问题；其结果为源码审查，未冒充运行回归。
