# WeKnora 原生智能体 MCP 与工作台收口执行方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主产品通过 MCP 管理和选择 WeKnora 原生智能体，并完成知识库范围、问答模式、真实执行与页面展示的一致性验收。

**Architecture:** 智能体资源、知识库、权限、模型与执行链全部留在 WeKnora。WeKnora-Agent 只是独立 MCP 工作台和原有 LangChain CLI，页面的业务操作经过本地薄代理调用 MCP。复用现有改动完成部署和验收，不重新搭建智能体系统。

**Tech Stack:** Go、现有 MCP server、WeKnora CustomAgent 服务；Python 薄代理、原生 JavaScript 页面、既有 LangChain CLI；Docker 本机原型栈。

---

## 0. 先读：这是已有工作区的收口方案

日期：2026-10-21。两个项目：

- `E:\GoLandCode\WeKnora`
- `E:\GoLandCode\WeKnora-Agent`

**已经有实际代码修改，不能当作干净基线重新实现。没有为本轮创建提交。** 两个仓库还有用户及其他模型的修改，尤其 WeKnora 原生前端的裁剪；禁止整体回滚、覆盖工作区或直接 `git add .`。

用户最新要求是先交付方案，由其他模型执行。因此本轮最后一次后台构建已经停止，没有继续编写功能代码。

### 当前已确认的状态

| 项目 | 状态及证据 |
| --- | --- |
| `agent_workspace` 聚合工具 | 源码完成；七工具版本已部署过并完成真实管理和问答测试 |
| 智能体管理页面 | 源码完成：列表、查看、新建、编辑、复制、删除、进入问答 |
| QA 指定智能体和明确选库 | 已真实通过；请求、回答的 agent_id 和知识库集合一致 |
| 不检索知识库语义 | 已真实通过；空知识库集合、空引用、明确回答没有资料 |
| 编辑后的旧会话失效 | 单测及真实页面通过；原 session 清空 |
| 最后的模式回显修复 | **源码和后端测试通过，但尚未确认部署**；旧运行版本可能仍返回 `endpoint-default` |
| 最终页面智能体名称展示 | 源码和测试完成，仍需对最后镜像真实复验 |
| 智能推理真实验收 | **未完成**；此前环境记录缺少 Rerank，最近请求受 Docker 故障干扰，不能写成已通过 |
| 临时智能体清理 | **仍有两个待删**，见 Task 5 |
| 运行环境 | 本轮结束前已恢复 WeKnora app/UI/Redis/Neo4j/DocReader；app、Redis、Neo4j、DocReader 的 Docker health 均 healthy |
| 后台构建 | 本轮拥有的构建已停止；测试容器 `WeKnora-wiki-check` 保持停止 |

最后恢复的是已有容器及已有镜像，**容器 healthy 不代表最后源码补丁已经部署**。

## 1. 最终产品边界与工具设计

### 1.1 保留七个聚合工具

| MCP 工具 | 职责 |
| --- | --- |
| `knowledge_base` | 列库、详情/能力/解析器目录、新建知识库 |
| `ingest_document` | 文件上传导入、指定解析配置、阶段状态轮询 |
| `search_knowledge` | 文档、Wiki、实体图谱证据检索 |
| `read_document` | 文档/Wiki 目录与正文回读 |
| `ask` | 原生快速问答、智能推理、端点档案、指定原生智能体与会话 |
| `wiki_workspace` | Wiki 页面增删改、历史/恢复、页面链接图 |
| `agent_workspace` | 原生智能体 list/get/create/update/delete/copy |

七个是包含 Wiki 管理和智能体管理后的领域聚合结果。不要为每个 CRUD 再创建一个 MCP 工具，也不要为了硬压到五个而把智能体管理塞入文档工具。统一入口仍为 `/mcp/core/:endpoint_id`。

### 1.2 Agent 项目保持独立

允许的调用链：

```text
主产品 / WeKnora-Agent 页面
  → 本地 /api/tool 或 /api/ask 薄代理
  → 标准 MCP
  → WeKnora 原生权限、资源服务和问答链
```

禁止在 Agent 项目增加 WeKnora 数据库访问、Python/Go 内部模块依赖、知识业务 REST 客户端、本地智能体数据库、自动登录/代管理员代理，或复制一套 RAG/Wiki/图谱执行逻辑。独立凭证生成器继续在原有位置正式签发身份。

Redis、Neo4j、DocReader 属于 WeKnora 服务栈，不是薄 Agent 的独立业务依赖。不要恢复已裁剪的长期记忆、IM 发布、网络搜索、沙箱、技能和第三方 MCP 客户端。

### 1.3 需要遵守的现有契约

- `agent_workspace` 参数：`action, agent_id, name, description, config`。
- list 返回 `{agents:[...]}`；get/create/update/copy 返回 `{agent:...}`；delete 返回 `{deleted:true}`。
- 配置仅开放知识问答字段：`agent_mode, agent_type, system_prompt, model_id, rerank_model_id, kb_selection_mode, knowledge_bases, retrieve_kb_only_when_mentioned`。
- 显式原生智能体使用 `ask.agent_id`，与调用参数 `mode/profile_id` 互斥。`profile_id` 是端点发布档案，不能冒充智能体目录。
- `agent_workspace` 必须端点显式授权，默认关闭；管理和显式选智能体要求真实 WebUser。写入遵守 Contributor 下限、创建者/管理员规则；内置项只读但可复制。
- 显式请求知识库必须授权；未显式选库时遵循智能体的 all/selected/none/仅提及时配置，并与端点及请求范围求交集。
- 空范围必须固定在执行配置中，不能被下游扩大。原非空工具白名单过滤为空时明确拒绝，不能退回默认检索工具。
- 回答使用实际选中的对象；返回真实 agent_id、真实运行模式和最终知识库集合。会话绑定同样使用这些值；切换范围/模式/智能体不得沿用不匹配会话。
- 原生 Wiki 链接通过编辑页面正文 `[[slug|标题]]` 维护；实体抽取图原生没有公开的直接编辑接口，不新增绕过原生服务直改 Neo4j 的接口。

## 2. 代码与证据地图

### WeKnora

| 文件 | 作用 |
| --- | --- |
| `internal/mcpserver/core_agent_workspace.go` | 安全 DTO、管理动作、RBAC/租户、配置白名单、知识范围、模型默认值与验证、运行时工具过滤 |
| `internal/mcpserver/core_agent_workspace_test.go` | 管理/权限/配置/执行/模式/选库/会话回归 |
| `internal/mcpserver/core_ask.go` | agent_id 选择、已授权执行计划、会话绑定、实际模式回显 |
| `internal/mcpserver/tools_ask.go` | 私有计划直传执行、显式智能体的原生选库语义 |
| `internal/mcpserver/core_policy.go`、`core_server.go`、`server.go` | 聚合工具许可与注册，含旧兼容面目录一致性 |
| `internal/types/mcp_endpoint_tools.go` | 默认关闭的端点授权项 |
| `internal/mcpserver/core_wiki_workspace.go` 及测试 | 既有 Wiki 管理封装，保留并做防回归 |
| `internal/application/service/wiki_page.go` 及版本守卫测试 | 既有 Wiki 更新版本冲突防线，不能被覆盖 |

### WeKnora-Agent

| 文件 | 作用 |
| --- | --- |
| `web/assets/agent-view.js`、`agent.css` | 智能体管理页及目录缓存 |
| `web/assets/views.js` | QA picker、进入问答、会话失效、答案身份展示、诊断说明 |
| `web/assets/app.js`、`web/index.html` | 导航、状态、agent_id/明确知识库参数 |
| `webapp.py` | `/api/ask` 将 agent_id 和 knowledge_base_ids 转发到 MCP；写类工具标记 |
| `tests/test_agent_view.js`、`tests/test_identity_lifecycle.js` | 页面、身份与旧流防护回归 |
| `tests/test_webapp_routes.py` | 薄代理参数转发回归 |
| `agent.py`、`main.py` | 既有 LangChain CLI，不应扩展成本地业务系统 |

### 已通过的检查

- 前端 Node：**102 通过**，日志 `WeKnora-Agent/.planning/2026-10-21-wiki-workspace/node-tests.log`。
- Python 指定四个测试文件：**71 通过**，同目录 `python-tests.log`。
- Linux `sqlite_fts5`：完整 MCP server/types 测试通过，最后模式补丁日志为 `WeKnora/.planning/2026-10-21-wiki-workspace/go-mcp-types-mode-final.log`。
- Wiki 服务版本守卫回归通过；相关 Go vet 通过。不能据此写成全仓库所有测试通过。
- 真实问答及空范围证据：`WeKnora-Agent/.planning/2026-10-21-wiki-workspace/native-agent-live-evidence.json`。其中保留旧模式回显以证明发现问题，不能将它当成最后模式补丁的通过证据。

## Task 0：核对工作区和环境，防止重复实施

- [ ] 分别在两个仓库运行 `git status --short`，阅读上述文件及现有差异。保留所有其他模型修改，不按旧交接的“没有生产修改”口径重置。
- [ ] 阅读 `docs/2026-10-21-native-agent-workspace.md` 作为详细背景，**当前执行状态以本文为准**。
- [ ] 确认没有其他镜像构建，尤其 `weknora-ui:local frontend/`。并行原生前端构建曾导致两次 Docker/WSL 失去响应；不要自动并行重试或无限重启 Docker。
- [ ] 读取真实容器状态：

```powershell
docker ps --format '{{.Names}} {{.Status}} {{.Image}}'
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -in @('docker.exe','docker-compose.exe') -and $_.CommandLine -match '\bbuild\b' } |
  Select-Object ProcessId,CommandLine
```

验收结束需要 app/UI/Redis/Neo4j/DocReader 正常运行；`WeKnora-wiki-check` 是离线测试容器，不必常驻。

## Task 1：确认最后补丁已经存在，不再重写功能

- [ ] 检查 `core_ask.go` 显式 agent_id 解析成功后存在 `plan.Mode = agent.Config.AgentMode`，执行仍使用私有已解析计划，不能因为设置 quick-answer 又改成内置智能体。
- [ ] 检查 `TestCoreAskExplicitAgentIsAuthorizedAndActuallyExecutes` 和 `TestCoreAskExplicitAgentModeChangeRefusesSessionReuse`。前者核验实际执行对象和模式；后者保证同 ID 改运行模式也拒绝旧会话。
- [ ] 检查 `Views.openQaForAgent`、`Views.onAgentsChanged`：保留 QA 范围、选择原生 ID、开启新会话；配置变动使指定智能体旧流失效，不清空无关 quick/smart 会话。
- [ ] 如果本轮未改源代码，直接使用已有绿色回归证据，进入部署。若发现新缺陷，先补能复现的失败断言，再最小修复并运行相关回归，不能通过删除断言或绕过授权解决。

可复用的轻量命令：

```powershell
# E:\GoLandCode\WeKnora-Agent
node --test tests/test_*.js
.\.venv\Scripts\python.exe -m pytest -q tests/test_agent.py tests/test_http_mcp.py tests/test_project_boundary.py tests/test_webapp_routes.py
```

预期分别 102 和 71 通过；若新增合理测试，记录新数量。PowerShell/Node 如不展开通配符，改用 `Get-ChildItem tests/test_*.js` 构造文件参数数组。

后端如有修改，应在现有 Linux 检查环境、同步当前源文件后运行：

```sh
GOMAXPROCS=1 GOMEMLIMIT=512MiB go test -p 1 -tags sqlite_fts5 ./internal/mcpserver ./internal/types
```

不要直接相信旧测试容器里的 `/app` 等于宿主最新源文件；不要在重建生产镜像时同时编译这组测试。Windows 本机已有 CGO/pg_query 环境问题，不要因此改业务实现。

## Task 2：单独重建和部署最后模式补丁

- [ ] 与其他任务协调，确保同一时段只有本轮构建。构建前可暂停当前 WeKnora 容器释放内存，记录并在构建后恢复；这不是删除容器或数据卷。
- [ ] 保持生产标签 **`anydoc,sqlite_fts5`**。不能为让构建通过而关闭 AnyDoc/PDF 解析、换成无 FTS5 二进制或拿旧镜像伪装当前源码。
- [ ] 两个构建入口任选一个，不要同时运行：
  - 标准、可复现入口：`examples/mcp-validation/deploy/Dockerfile.prototype-app`。
  - 本机加速入口：`.planning/2026-10-21-wiki-workspace/Dockerfile.cached`，依赖本地 `weknora-agent-wiki-cache:local`；临时文件已设 GOMAXPROCS=1、GOFLAGS=-p=1、GOMEMLIMIT=512MiB，业务构建标签不变。先确认缓存镜像存在，不要把这个本机依赖写入产品默认配置。

标准构建与部署命令（在 WeKnora 根目录）：

```powershell
docker compose -f examples/mcp-validation/deploy/compose.prototype.yml -f examples/mcp-validation/deploy/compose.prototype.docreader.yml --env-file examples/mcp-validation/deploy/.env.prototype build weknora
docker compose -f examples/mcp-validation/deploy/compose.prototype.yml -f examples/mcp-validation/deploy/compose.prototype.docreader.yml --env-file examples/mcp-validation/deploy/.env.prototype up -d
```

如选择本机加速入口，只在该 PowerShell 进程临时设置 `WEKNORA_DOCKERFILE`，结束后恢复原环境值。不要把含密码的 `.env` 或凭据打印进日志。

- [ ] 记录构建退出码、镜像 ID、容器实际镜像 ID、健康状态。仅日志出现 `go build` 不算构建成功。
- [ ] 恢复 DocReader 并确认 healthy。上一次交接前五个原型容器已恢复，先读状态再决定是否需要启动。

## Task 3：重新连接工作台并核对权限

本机地址：工作台 `http://127.0.0.1:18100`；WeKnora API `http://127.0.0.1:18082`；原生 UI `http://127.0.0.1:18180`。

- [ ] 当前工作台端点 ID 是 `cc7eb833-82cb-4105-bd79-5ad2ee4a809b`，以 Agent `.env` 实际配置复核。**不要误改历史端点 `eb2d80a9-02ed-4da0-b823-0cab73b94c86`。**
- [ ] 活跃端点已通过正式管理 API 增加 `agent_workspace`，且保留 `wiki_workspace`；先回读，不要再次直写数据库。用户当前工作空间为 2。
- [ ] 刷新工作台，配置 Token → 读取本机凭证，**等待“凭证已读取”出现后**再连接。不能把 Docker 故障时缓存的空工具目录当作新代码缺失。
- [ ] 从 MCP `tools/list` 断言恰好七个工具，名称与第 1 节相同。若 Agent 页面只读，先核对实际端点、身份、目录及许可，而不是删权限校验。
- [ ] 凭据文件为 `WeKnora/examples/mcp-validation/deploy/workbench-user-token.local.json`，不得粘贴到方案、日志或提交。当前凭据记录到期时间为北京时间 2026-10-22 10:30；若过期，走既有独立生成器正式刷新，不在工作台内增加自动登录。

## Task 4：真实页面验收，检查执行结果而非仅看下拉框

使用库 `54281b47-333b-41f3-a6ad-860a543267b8`（MCP纠偏核心验收-20261014）。已知原文：`负责人.md` 说明张三负责项目 A，承担实施协调、上线审批、运行维护。

优先复用下节尚存的临时原智能体；如果已被清理，再新建唯一前缀临时项。不要修改既有用户资源。

- [ ] 原生列表正常；内置智能体编辑/删除不可用，可复制；自定义资源按权限显示。
- [ ] 新建或读取临时项，配置文档问答、快速模式、默认指定上述知识库；系统提示词要求回答末尾增加“原生智能体验收成功。”。编辑与复制已经实测过，未改代码时不必再重复制造资源。
- [ ] 点击详情“用此智能体问答”，确认指定智能体模式、正确 ID、保留已有 QA 范围、session 清空。
- [ ] 明确选择目标库，问“项目A的负责人是谁？他承担哪些职责？请引用资料。”。
- [ ] 检查请求包含 `agent_id`、`knowledge_base_ids`，不含 `mode/profile_id`。检查回答张三及三个职责、引用 `负责人.md`、出现自定义标记；返回 agent_id 与所选一致、mode 为 **quick-answer**、知识库集合只有目标库；页面显示该智能体名称。
- [ ] 页面选择“不额外收窄”时再次使用同一智能体，确认实际范围遵循它的默认指定库，并不自动扩大到所有库。
- [ ] 编辑其范围为“不检索”，确认旧会话清空；QA 选择“不额外收窄”，再次提问必须知识库集合为空、无引用、明确无资料。前一版本已有真实通过证据，最后模式补丁后至少检查 mode 和选库不回退。
- [ ] 修改模式/知识库/智能体后，不得展示旧流或续用旧绑定。直接复用不匹配 session 的 MCP 调用应明确拒绝，不能先写入问答消息再失败。
- [ ] 单独测试原生智能推理。成功必须有可核对的证据；若返回缺少 Rerank 或其他模型配置，保存明确错误并记录“环境受限”，不可降级为快速问答后算通过，也不要擅自购买/切换外部模型。
- [ ] Wiki 页打开编辑器并取消，页面到链接图跳转正常。实体图继续支持检索和独立来源回读，不制造直接编辑实体关系的能力。

建议验收表：

| 检查 | 请求关键字段 | 实际 agent/mode/KB | 来源或拒绝证据 | 结论 |
| --- | --- | --- | --- | --- |
| 指定智能体 + 显式选库 | agent_id + knowledge_base_ids | 必须逐项核对 | 负责人.md + 提示词标记 | pass/fail |
| 智能体默认范围 | agent_id，不传额外选库 | 默认指定库的授权交集 | 不得扩大到全库 | pass/fail |
| 不检索 | agent_id，不传额外选库 | 空集合 | 无引用、明确无资料 | pass/fail |
| 模式/范围/身份变化 | 不匹配旧 session | 服务端拒绝或客户端新会话 | 旧流不回写 | pass/fail |
| 智能推理 | mode=smart-reasoning | 必须实际使用该模式 | 有据回答或具体模型错误 | pass/环境受限/fail |

## Task 5：清理测试资源并完成交接

以下两个临时项在上一轮 Docker 故障前已创建，**尚未确认删除**：

| ID | 名称 |
| --- | --- |
| `2ce29852-0f34-4927-8c3f-82b2b0e23fb2` | `MCP页面验收-1792568990940-已编辑` |
| `75ea5c3a-97ac-4eb0-8429-d81eb8412f9c` | `MCP页面验收-1792568990940-副本` |

- [ ] 使用页面确认删除或 `agent_workspace.delete` 删除这两项；按 ID 和唯一前缀双重核对，不能批量删除其他用户资源。
- [ ] 重新 list 确认两个临时 ID 不存在，原有 5 项仍在：四个 builtin 与 `b4572f55-1dee-43b8-ab9b-9e5c4bf5caa5`。若用户期间增加资源，保留新增项，不强行让数量等于 5。
- [ ] 测试库原有 10 文档、244 分块、90 Wiki 页。没有本轮新增内容时保持不变；用户同期变动须单独说明，不擅自“恢复”计数。
- [ ] 恢复 app/UI/Redis/Neo4j/DocReader，记录健康状态；不要留下为了构建暂停的解析服务。工作台端口 18100 正常，Token 过期能明确提示。
- [ ] 更新 `docs/2026-10-21-native-agent-workspace.md`：将“待最后部署”改为有镜像 ID 和真实结果的结论；写明智能推理是否受限、临时资源是否清理。不要保留互相矛盾的完成声明。
- [ ] 输出本轮实际改动清单、检查结果和剩余限制；用户未要求时不合并、推送或批量提交其他人的工作区改动。

## 完成标准

只有以下条件同时满足，才可报告全部收口：七工具目录正确；原生智能体管理和指定执行真实可用；模式回显补丁进入运行镜像；明确选库/智能体默认范围/空范围均生效；页面显示实际智能体；权限与会话回归通过；临时资源清理；PDF 解析服务恢复。智能推理缺模型时必须单独标“环境受限”，不得以“页面上能选”代替执行验证。
