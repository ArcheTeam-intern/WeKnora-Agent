# WeKnora MCP 封装与纯 LangChain Agent 验证方案

> **供执行模型：** 如环境具备技能，按 executing-plans 逐任务实施；第 8 节用勾选步骤跟踪。保持当前纯 Agent 边界，不从归档旧应用方案重新开工。

**目标：** 完成 WeKnora MCP 核心知识链路及能力评估，WeKnora-Agent 仅保留标准 LangChain 与 MCP 配置。

**架构：** 所有知识业务、身份权限、上传及来源封装由 WeKnora 提供。Agent 使用标准 SDK 和 create_agent，通过 CLI 验证；部署和离线评估放在 WeKnora 验证目录。

**技术栈：** Go/Gin/mcp-go/现有 WeKnora 存储、队列和 Neo4j；Python 3.12+、LangChain、langchain-mcp-adapters、ChatOpenAI。

更新日期：2026-10-13。此方案替代此前“薄 FastAPI 后端＋Vue 演示工作台”的范围。主要开发对象为 WeKnora MCP；WeKnora-Agent 只用于验证标准 LangChain 对 MCP 的调用，不建设另一个应用。

## 1. 最终边界

WeKnora-Agent 只保留：
- LangChain 模型初始化。
- 标准 MCP SDK／langchain-mcp-adapters 连接配置及工具发现。
- create_agent 构建单 Agent。
- 问题输入、运行与输出的命令行入口。
- 必要的依赖、配置示例、说明及少量集成测试。

不包含 frontend、自建 FastAPI／Uvicorn 服务、登录代理、Cookie／SessionStore、知识业务路由、上传转发、数据库、任务管理、证据 Registry、图谱展示、评测平台、Docker 编排或自研 Agent 运行时。MCP SDK 自身可能传递引入 Uvicorn、Starlette 等依赖，这不表示本项目运行了 Web 服务；不能为了去掉 SDK 的正常依赖复制其协议实现。评估离线脚本和 WeKnora 部署工具放在 WeKnora 仓库的验证／示例目录，不作为 Agent 的运行依赖。

登录、业务空间、用户权限和资料操作继续使用 WeKnora／主产品。上传、解析、检索、Wiki、实体关系图谱、异步任务、来源与错误均由 WeKnora MCP 封装负责。既有 WeKnora 页面提供资料管理，不再为验证 Agent 另建前端。

## 2. Agent 的最小结构和行为

目标目录：

```text
WeKnora-Agent/
  main.py                 # 配置读取、命令行输入、async 调用和输出
  agent.py                # 标准 SDK get_tools + create_agent 工厂
  mcp.json                # MCP 地址和环境变量引用，无明文密钥
  requirements.txt
  .env.example
  README.md
  tests/                  # 少量标准 MCP／Agent 集成测试
  docs/                   # 当前方案，不参与运行
```

固定使用当前 LangChain create_agent 路线，复用已锁定的 langchain-mcp-adapters.MultiServerMCPClient。无需再设计 LangGraph StateGraph；若未来切换 LangGraph，仍保持同样的无业务客户端边界。本阶段不同时维护两套实现。

调用顺序只有：读取环境与 MCP 配置 → 初始化模型 → SDK get_tools → create_agent → ainvoke／标准 astream → 输出答案／SDK 原始工具事件。模型、Agent 和工具使用标准对象，不新增 BaseChatModel 子类或通用兼容运行时。

mcp.json 是 SDK connections 形状，例如：

```json
{
  "weknora": {
    "transport": "streamable_http",
    "url": "${WEKNORA_MCP_URL}",
    "headers": {
      "Authorization": "Bearer ${WEKNORA_MCP_TOKEN}",
      "X-WeKnora-User-Token": "${WEKNORA_USER_TOKEN}",
      "X-Tenant-ID": "${WEKNORA_WORKSPACE_ID}",
      "X-WeKnora-Knowledge-Base-Ids": "${WEKNORA_KB_IDS}"
    }
  }
}
```

main.py 在内存解析明确的环境变量引用；缺失必填配置直接报错，不发送未展开的占位符。环境变量由调用者／本地受限配置提供，Agent 不登录、不刷新 JWT、不查询成员、不计算授权。模型变量固定为 AGENT_MODEL、AGENT_MODEL_BASE_URL、AGENT_MODEL_API_KEY；MCP 变量如上。WEKNORA_KB_IDS 为 1～10 个明确 UUID 的逗号分隔值，实际权限仍由 WeKnora 校验。

验证端点只启用问答所需的只读工具。SDK 工具发现直接交给框架；不手写 MCPClient 类或复制 SDK。误配置暴露写工具时，仅以短小的显式只读工具名单交集防护并报配置问题，不增加工具包装器。文件导入和 upload status 不交给问答模型。

提示词只要求基于工具返回资料回答、使用 WeKnora 提供的真实 document／chunk／Wiki／relation 来源标识，并说明证据不足与冲突。不要在 Agent 后端另造 E 编号、来源映射或修改工具内容；WeKnora 返回自包含、可引用的 MCP 结果。标准 MCP artifact／content 交给 SDK，SDK 协议兼容问题在依赖或服务响应层修复，不建设千行输出归一化模块。

首期采用框架原生 recursion_limit 防止无限工具循环、模型 timeout 及整个异步调用的 120 秒超时。原方案精确统计每次重试的自研预算层不作为本原型必需项；实际调用数由标准回调／事件在离线评估中统计。需要更严格限制时优先原生 middleware，不重新写 _BudgetedChatModel。

对外仅有“一个问题／消息输入 → Agent 返回结果”的库函数与 CLI。不增加 HTTP API。调用者需要多用户或 Web 接入时，在主产品侧持有身份并为每次运行构造独立连接，Agent 不缓存跨用户身份。

## 3. WeKnora MCP 才是主要实施内容

服务入口为 /mcp/:endpoint_id，文件字节传输为同一集成服务的 POST /mcp/:endpoint_id/uploads。所有知识业务动作通过 MCP；文件传输、登录 API 属于 WeKnora 服务，不复制到 Agent。

保留并验证：
- 知识库／文档列表、search_knowledge、grep_chunks、read_document。
- wiki_index、wiki_search、wiki_read_page、wiki_list_pages、wiki_graph。
- query_knowledge_graph：真实 Neo4j 查询、逐关系来源、截断和故障。
- import_document_file、get_upload_status、文档／知识库状态工具。
- require_user_identity、用户／空间／端点／所选 KB 的范围交集。
- WeKnora 自有文件暂存、mcp_uploads 回执、原子领取、重试恢复与清理。

原则不变：
1. 端点令牌和用户 JWT 由服务验证；裸 user／workspace／KB 参数不能授予权限。用户模式缺授权依赖拒绝，不能降级机器身份。
2. 选择范围头仅收窄；无交集拒绝。按文档 ID／Wiki slug／关系读取同样检查范围。调用者身份与资源 owner 分离，多 KB 批次按各 owner 执行。
3. 文件入口和导入复用原上传角色、归属与写权限。先以原 caller 查 upload，再授权 KB，最后切 owner 创建文档。
4. 文件类型、50 MB 上限、哈希、过期、Idempotency-Key、upload_id 幂等和持久回执都由 WeKnora 处理。清理前持久回执，响应丢失不重复建文档。
5. 工具返回标准 MCP content／structuredContent／isError；错误码、retryable、部分失败及截断清晰，不把失败当空检索。
6. Wiki 多来源及图谱逐关系 source_refs_v2、自身知识库、document_id／chunk_id 和可核验原文必须由服务给出，不能让不同客户端猜映射。缺来源标为未知。
7. 文档可检索、Wiki 可浏览、图谱可查询分别验证，不因上传成功就宣称生成完成。

WeKnora 主要文件：internal/mcpserver、internal/middleware/mcp_endpoint_auth.go、internal/mcpscope、internal/router/routes_mcp_endpoint.go、相关 types／service／migrations 和 Neo4j repository。已有代码先验证再补差异，不从零重写。

历史方案里服务侧的状态机、权限、来源和异常测试仍可参考，但其中要求新 Agent 自建会话、证据、预算、登录代理、前端和 API 的内容已撤销；当前文件优先。

## 4. 裁剪后的实际代码与交接

2026-10-13 已执行代码裁剪。原 backend/app 的 33 个文件、约 10992 行实现已退出项目运行目录。新生产代码只包含 main.py 与 agent.py，直接使用标准 SDK，不导入旧 backend。

旧 backend、frontend、deploy、scripts、eval 和全部历史 docs 已完整移到 E:/GoLandCode/WeKnora-Agent-archive/20261013-105051。旧 .gitignore 及归档清单一并保存；旧本地秘密配置、虚拟环境、语料和报告没有删除。根目录仅保留新入口、配置、README、当前方案及必要测试，.venv 是独立安装的忽略目录。

WeKnora 服务部署配置、Dockerfile、十文档语料、十二题和生成器迁到 E:/GoLandCode/WeKnora/examples/mcp-validation。新 Compose 仅保留 weknora、weknora-ui、redis、neo4j、weknora-check，沿用原型项目、容器、网络和数据卷名；不编排 Agent 前后端。现有 WeKnora MCP 业务源码及权限、Wiki、图谱和上传封装保留，本次不改写它们。

WeKnoraAgent-backend 和 WeKnoraAgent-frontend 容器已停止；知识服务及存储继续运行。本次未重建 WeKnora 镜像，也未删除数据或镜像。旧评估器、smoke 和 import 脚本依赖旧 HTTP 应用，已归档；不能机械迁移后宣称适配当前 Agent。可复用生成器与语料迁入服务验证目录。

## 5. 验证范围与待办

新 CLI 支持环境配置读取与 SDK 原生 connections；模型通过 ChatOpenAI 初始化；build_agent 只发现工具、筛选只读工具及 create_agent；run 用原生 ainvoke、recursion_limit 和整体 asyncio.timeout。返回标准 messages，不加工证据、引用编号或协议响应。

测试启动真实 MCP SDK stdio 传输，使用预设模型消息触发标准 Agent 的 search_knowledge、wiki_read_page、query_knowledge_graph，并验证写工具不可调用、MCP 工具失败标为 error、配置缺失非零退出、敏感值不回写 JSON 及总超时。此测试中的文档、Wiki 和图谱结果为测试数据，不能作为线上召回／准确率证据。

必须分别确认：
- 独立环境安装成功、pip check 无依赖冲突、pytest tests 通过、CLI --help 可用。
- 活跃目录无 frontend/backend/deploy/eval/scripts、自定义运行时及项目自建 Web API；仅两个生产 Python 文件。
- 迁移后的 WeKnora Compose config --quiet 通过；秘密配置被忽略；既有知识服务继续健康。

真实 WeKnora + 实际模型问答尚需提供有效的模型配置、端点 token、用户 JWT、业务空间及所选 KB，进行 Streamable HTTP 发现工具及问答。此轮本机旧部署没有保存 Agent 模型凭据，不能以预设模型测试代替实际模型验证。不得宣称检索完整性或答案准确率已经通过。

下一阶段主要修改 WeKnora MCP，先补齐服务侧调用验证；离线评估直接消费标准 Agent 原始工具消息／事件。服务验证目录 README 给出证据召回、文档找齐、事实准确、完整、引用支持与异常指标及原型验收门槛。不要为评估重新给 Agent 添加登录、业务 API、证据 Registry、图谱处理或自研预算层。

运行方式：
```powershell
Set-Location E:\GoLandCode\WeKnora-Agent
.\.venv\Scripts\python.exe main.py --question "说明这个项目的负责人和依赖关系"
.\.venv\Scripts\python.exe -m pytest tests -q
```

## 6. 给接手模型的执行说明

> 本文件是当前交接主方案，覆盖归档中的旧方案。接手者逐任务执行和验证；如本地具备相应技能，可使用 executing-plans。用户要求其他模型执行后续工作，本次文档更新不继续实现下面的服务任务。

**目标：** 保持 WeKnora-Agent 为纯标准 Agent，完成 WeKnora MCP 的文档、RAG、Wiki、实体图谱、权限和来源链路，并用真实模型验证和离线评估能力边界。

**架构：** WeKnora 独立承担业务和 MCP 服务；Agent 只用标准 SDK 发现／调用工具。资料管理复用 WeKnora 前端；评估与部署放 WeKnora 的 examples/mcp-validation，不进入 Agent 应用。

**技术：** WeKnora Go/Gin、mcp-go、现有存储／队列和 Neo4j；Agent Python 3.12+、LangChain create_agent、langchain-mcp-adapters、ChatOpenAI。首期不另建 LangGraph StateGraph，不维护两套 Agent。

### 6.1 优先阅读和实际进度

接手时先读以下文件，不要从历史完整应用方案重新开工：

1. 本文件，尤其第 7～12 节。
2. `E:/GoLandCode/WeKnora-Agent/main.py`、`agent.py`、`mcp.json`、`tests/test_agent.py`。
3. `E:/GoLandCode/WeKnora/examples/mcp-validation/README.md` 与 `deploy/compose.prototype.yml`。
4. `WeKnora/internal/mcpserver`、`internal/middleware/mcp_endpoint_auth.go`、`internal/mcpscope/scope.go`。
5. `WeKnora/internal/types/extract_graph.go`、`internal/agent/tools/query_knowledge_graph.go`、Neo4j repository。

| 事项 | 2026-10-13 的状态 | 接手动作 |
| --- | --- | --- |
| 纯 Agent 裁剪 | 已实现，生产代码两个文件 | 保持结构，做验收；不要重新造应用 |
| 旧应用归档 | 已完整移动至第 4 节路径 | 保留备份，不自动删除 |
| 独立 Agent 环境 | 新 .venv 安装成功 | 用其运行，禁止依赖归档 backend 环境 |
| 标准框架／MCP 测试 | 新环境 7 passed，pip check 无冲突，CLI help 通过 | 增加 HTTP／真实服务验证，不把预设模型当真实模型 |
| WeKnora 部署资料迁移 | 已完成，Compose config 通过 | 新建镜像前检查构建路径及现有容器版本 |
| WeKnora MCP 功能源码 | 已有大量未提交实现 | 先检查测试再增量修复；不能覆盖其他人的改动 |
| 上传／导入实测 | 此轮未做 | 按任务 3 验证 |
| 十文档真实 ID 映射 | 当前 manifest 中真实 ID 为空 | 导入后回填，不能声称语料已索引 |
| Wiki／实体图谱真实验证 | 此轮未做 | 分别验证，不能互相替代 |
| 实际模型问答 | 未完成，未保存可用模型配置 | 配置后跑任务 7 |
| 十二题准确性评估 | 未完成，当前只有题库／复核模板 | 跑任务 8，保留原始证据与人工评分 |

已验证的直接依赖为 requirements.txt 中的五项；新环境传递安装 langchain-core 1.6.10、langgraph 1.2.15。不要凭旧环境版本声称整个传递依赖已经锁定。需要可重复安装时记录本次测试版本或增加简短 constraints；不添加自研兼容层。

### 6.2 任务优先级

| 优先级 | 内容 | 完成条件 |
| --- | --- | --- |
| P0 | 保持纯 Agent、权限范围、错误可识别 | 无旧应用依赖；越权失败；错误不等于零结果 |
| P0 | 图谱逐关系来源纠正 | 不再把同一批检索证据配给所有边；未知不标 verified |
| P1 | 上传到可检索的核心流程 | 暂存、导入、状态、原文检索均实测 |
| P1 | Wiki 与实体图谱 | 真生成／真查询、来源可核验、故障可识别 |
| P1 | 实际模型调用和十二题评估 | 有原始运行轨迹、分子分母及人工复核 |
| P2 | 更多格式、更多语料、性能及更严格预算 | 首轮核心门槛后再扩展，不阻塞最小原型 |

当前不裁剪 WeKnora 本体的未使用模块。先跑通并画清依赖，后续单独决定哪些模块删除，避免破坏已有文档／Wiki／图谱能力。

### 6.3 独立审查补充

已对当前 Agent 和部署结构进行只读独立审查：两个生产文件符合纯标准框架边界；没有发现需要立即改架构的 Critical 问题。审查没有替代真实 WeKnora／模型实测，以下问题已纳入任务：

| 发现 | 性质 | 处理任务 |
| --- | --- | --- |
| 默认 Streamable HTTP 和四个身份／范围头尚未实测 | Important，验证缺口，并非已确认鉴权漏洞 | 任务 1、2、7 |
| 发现任意一个允许工具即可创建 Agent，缺核心工具时无提示 | Important，端点能力配置风险 | 任务 1、7：服务验收必须检查 13 项名单 |
| 超时测试只模拟工具发现阻塞，没有真实模型／工具等待和循环耗尽 | Minor，测试覆盖缺口 | 任务 1 |
| 非空 JSON 字典之后主要交 SDK 校验，配置错误分类较粗 | Minor，诊断问题，已有非零退出 | 任务 1：保留 SDK 校验，必要时短小脱敏分类 |

这些是下一执行模型的明确工作项；本轮按用户要求只更新方案，不继续改生产代码。

## 7. 固定边界、接口和验收契约

### 7.1 目录及文件职责

Agent 允许的生产文件：

| 文件 | 唯一职责 | 禁止加入的内容 |
| --- | --- | --- |
| `WeKnora-Agent/main.py` | 读取 env／SDK connections、初始化 provider、CLI 调用 | 登录、数据库、上传、业务 API、任务轮询 |
| `WeKnora-Agent/agent.py` | get_tools、只读名单、create_agent、短提示词 | 自研 runtime、工具结果归一化、证据 Registry、模型包装器 |
| `mcp.json`、`.env.example` | 标准连接、身份转发和模型配置 | 明文 token、用户管理、角色判断 |
| `tests/` | 框架／协议集成测试 | 被生产运行导入的模拟服务或业务实现 |

离线验证归属：

```text
WeKnora/examples/mcp-validation/
  README.md
  deploy/                         # 已迁移，仅 WeKnora 服务
  scripts/make_corpus.py           # 已迁移，标准库生成器
  scripts/mcp_smoke.py             # 待实现，原生 MCP 服务自检
  scripts/import_corpus.py         # 待实现，独立服务导入与真实 ID 回填
  scripts/run_eval.py              # 待实现，标准 Agent／基线的离线运行
  scripts/score_eval.py            # 待实现，标注与人工评分汇总
  eval/corpus/manifest.json        # 已存在，真实 ID 当前为空
  eval/questions/demo-12.json      # 已存在
  eval/reports/                    # 运行报告，忽略秘密与原文输出
  tests/                          # 验证脚本自身的少量测试
```

此处“待实现”明确表示未来任务；这些脚本尚不存在。不要复制归档中依赖 `/api/auth`、`/api/chat/sessions`、旧 SSE 的脚本作为新实现。

WeKnora 主要改动位置：

| 路径 | 处理内容 |
| --- | --- |
| `internal/mcpserver/server.go` | 注册工具、依赖注入、SDK 结果与服务入口 |
| `internal/mcpserver/scope.go`、`scope_errors.go` | 范围解析／收窄、权限上下文、统一 MCP 错误 |
| `internal/mcpscope/scope.go` | 共享范围类型、请求头和稳定错误码 |
| `internal/middleware/mcp_endpoint_auth.go` | 端点 token、用户 JWT、成员和工作空间验证 |
| `internal/router/routes_mcp_endpoint.go` | MCP 和文件传输路由 |
| `internal/mcpserver/tools_retrieve.go` | 列表、检索、grep、原文读取 |
| `internal/mcpserver/tools_wiki.go` | Wiki 工具、页面来源、分页与链接图 |
| `internal/mcpserver/tools_graph.go` | 实体图谱输出及逐关系来源 |
| `internal/mcpserver/tools_status.go` | 文档／KB 的真实处理状态 |
| `internal/mcpserver/tools_import.go`、`upload_transport.go` | 上传暂存、导入、恢复接口 |
| `internal/mcpserver/upload_repository.go`、`upload_staging.go` | 服务自己的回执、租约与暂存清理 |
| `internal/types/extract_graph.go`、`wiki_page.go` | 关系身份与引用类型 |
| `internal/agent/tools/query_knowledge_graph.go` | 现有图谱查询业务工具，保留关系身份／出处 |
| `internal/application/repository/retriever/neo4j/repository.go` | 持久关系来源、方向、文档范围与数据库故障 |
| `migrations/sqlite/000034*`、`000035*`、`migrations/versioned/000115*`、`000116*` | 已有用户身份与上传回执迁移，先检查勿重建重复表 |

### 7.2 身份和范围

请求头固定：

| 请求头 | 来源与作用 |
| --- | --- |
| `Authorization: Bearer …` | WeKnora 签发的端点 token |
| `X-WeKnora-User-Token` | 调用方提供 WeKnora 用户 JWT |
| `X-Tenant-ID` | 用户实际业务空间 ID，当前服务为数值 ID，不能填 KB UUID |
| `X-WeKnora-Knowledge-Base-Ids` | 1～10 个明确 KB UUID，逗号分隔，仅收窄范围 |

有效范围 = 用户可访问范围 ∩ 端点范围 ∩ 本次选定 KB。端点 token 不能赋予用户原本没有的读写权限。用户模式端点设 `require_user_identity=true`；缺用户 JWT、成员服务或权限依赖必须拒绝，不降级成机器身份。保留历史机器模式兼容性，但不作为本原型用户权限验证的替代。

直接指定 knowledge_id、Wiki slug、upload_id 或关系 ID 同样检查范围。共享 KB 的 owner 上下文只用于资源读取／写入，不能覆盖请求 caller；上传回执始终绑定原 caller、空间、端点和目标 KB。

### 7.3 MCP 工具清单：当前参数与 Agent 可见性

下表参数来自当前服务源码。`tools/list` 的真实 inputSchema 是实际运行的首要依据；如不符，先核对运行镜像是否包含当前代码，不在 Agent 中硬补参数。

| 工具 | 必填参数 | 主要可选参数／限制 | 问答 Agent |
| --- | --- | --- | --- |
| `list_knowledge_bases` | 无 | 返回能力与当前 selection | 是 |
| `list_documents` | `knowledge_base_id` | keyword、page、page_size，20 默认／100 上限 | 是 |
| `search_knowledge` | `query` | mode=hybrid/semantic/keyword、limit 默认 10／上限 30、knowledge_base_ids | 是 |
| `grep_chunks` | `query` | limit 默认 10／上限 30、knowledge_base_ids；基于候选检索后正则过滤 | 是 |
| `read_document` | `knowledge_id` | offset、limit 默认 20／上限 100、query | 是 |
| `wiki_index` | `knowledge_base_id` | limit 按类型默认 50／上限 200 | 是 |
| `wiki_search` | `query` | regex、knowledge_base_ids、limit 默认 10／上限 50 | 是 |
| `wiki_read_page` | `slug` | knowledge_base_id；同名 slug 跨库时必须指定 | 是 |
| `wiki_list_pages` | `knowledge_base_id` | page、page_size 默认 20／上限 100、page_type、status、query | 是 |
| `wiki_graph` | `knowledge_base_id` | center、depth 1～2、limit 默认 100／上限 200、page_type | 是 |
| `query_knowledge_graph` | `knowledge_base_ids`、`query` | 最多 10 个有实体图谱配置的 KB | 是 |
| `get_document_status` | `knowledge_id` | 当前真实状态／子任务／错误 | 是 |
| `get_knowledge_base_status` | `knowledge_base_id` | 文档计数、Wiki 队列、图谱可用性 | 是 |
| `import_document_file` | `knowledge_base_id`、`upload_id` | 修改知识，只接受服务已暂存的上传 ID | 否 |
| `get_upload_status` | `upload_id` | 面向上传恢复，不用于问答规划 | 否 |

不得把 `read_document` 参数写成 `document_id`，也不能省略图谱查询的 `knowledge_base_ids`。测试 fixture 的简化参数不代表真实 WeKnora 契约。文件字节不能塞进 MCP 工具 JSON；路径、Base64 和客户端本地文件名不能替代服务 upload_id。

### 7.4 文件传输与状态

入口：`POST /mcp/:endpoint_id/uploads`，multipart 字段顺序为 `knowledge_base_id` 在前、`file` 在后；当前实现先授权目标再接收文件。沿用上面的身份／范围头，另加 `Idempotency-Key`。

当前成功回执：

```json
{
  "success": true,
  "data": {
    "upload_id": "服务签发的 UUID",
    "knowledge_base_id": "目标 KB UUID",
    "file_name": "example.md",
    "file_size": 1234,
    "sha256": "源文件 SHA256",
    "expires_at": "RFC3339 时间"
  }
}
```

上传只暂存，不创建文档；随后调用 import_document_file。按实际返回的知识 ID 调用 get_document_status，最后以检索／原文读取证明内容可用。Wiki 和实体图谱另做可用性验证，不以 parse_status=completed 推导全部生成成功。

导入超时：先 get_upload_status 查是否已经导入，若有文档回执则复用；仍 staged 才重试同一 upload_id；importing 时检查租约／恢复机制，不重新上传并创建另一篇文档。

初期部署文件上限 50 MB，服务使用 MAX_FILE_SIZE_MB 与现有文件大小规则。支持格式以当前 parser／上传白名单为准；主线先 MD/TXT，DOCX 和文本 PDF 分别验证 anydoc 构建；扫描 PDF／OCR 不列入首轮达标条件。

### 7.5 结果、错误与来源

保留标准 MCP `content`、`structuredContent`、`isError`。成功结果延续现有 payload，兼容字段增量加入；不能要求所有结果必须装入新的客户端信封。

失败目标契约：

```json
{
  "isError": true,
  "content": [{"type": "text", "text": "选定知识库之外的资源不可访问"}],
  "structuredContent": {
    "error": {"code": "KB_OUT_OF_SCOPE", "message": "选定知识库之外的资源不可访问", "retryable": false}
  }
}
```

HTTP 身份错误先返回相应 401／403；通过 MCP 工具执行返回的业务错误使用 isError。空命中是成功且 hits 为空；服务故障、权限失败、图谱关闭、Wiki 未启用不能伪装成成功空数组。多 KB 部分失败保留成功部分，同时给出 errors、partial 或现有等价字段；调用者能明确识别覆盖不完整。

优先复用 `scope_errors.go:errorResult` 和 `mcpscope.Error`。当前仍有 `NewToolResultError(err.Error())` 文本路径，需要逐工具转换。错误码至少覆盖已存在的 UNAUTHORIZED、FORBIDDEN、KB_SELECTION_REQUIRED、KB_OUT_OF_SCOPE、INVALID_ARGUMENT、NOT_FOUND、UPLOAD_EXPIRED、IMPORT_IN_PROGRESS、IDEMPOTENCY_CONFLICT、FILE_TOO_LARGE、INVALID_FILE_TYPE、UPSTREAM_UNAVAILABLE、GRAPH_NOT_CONFIGURED、GRAPH_UNAVAILABLE、WIKI_NOT_ENABLED、ENQUEUE_FAILED；使用源码常量，不重复另定义 Python 业务错误注册表。

当前 `types.SourceRefV2` 的字段是：

```json
{
  "knowledge_id": "真实文档 ID",
  "knowledge_base_id": "实际归属 KB UUID",
  "chunk_ids": ["属于该文档的 chunk ID"],
  "quote": "从原文读取的支持片段",
  "provenance_status": "verified"
}
```

按来源条目分别判断：已确定出处且读到支持原文可标 verified；知道出处但尚未核验原文标 unverified_source；不知道关系／页面出处标 unknown。任一条有 quote 不能让整批其他条目也变 verified。Agent 引用服务给出的实际标识，不造 E 编号；评估脚本可做离线映射，但不回灌生产结果。

## 8. 按任务执行的详细步骤

### 任务 0：建立工作基线，确认裁剪不需要重复

**读取：** Agent 当前两个生产文件；WeKnora git status；第 4 节归档；mcp-validation/deploy。

- [ ] 在 WeKnora 执行 `git status --short`、`git diff --stat`，记录已有未提交路径。禁止 `reset --hard`、`clean -fd` 或覆盖文件恢复旧版本。
- [ ] 确认 WeKnora-Agent 非 Git 仓库；本方案不自动初始化仓库、不假定它能 checkout／创建 Git worktree。
- [ ] 核对旧目录已退出 Agent，归档路径存在。不要第二次移动或删除旧资料，不把历史 docs 再放回当前入口。
- [ ] 从新 .venv 跑当前 7 项测试、pip check、CLI help。
- [ ] 校验新 Compose，只查看服务名、容器状态；不输出 config 中的秘密值。
- [ ] 保存 baseline.md 至 `WeKnora/examples/mcp-validation/eval/reports/`，含时间、代码版本、修改路径、命令／退出码、容器镜像 ID，去除 token 和密码。

命令：

```powershell
Set-Location E:\GoLandCode\WeKnora-Agent
.\.venv\Scripts\python.exe -m pytest tests -q
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe main.py --help

Set-Location E:\GoLandCode\WeKnora
git status --short
git diff --stat
docker compose -p weknora-agent-prototype -f examples/mcp-validation/deploy/compose.prototype.yml --env-file examples/mcp-validation/deploy/.env.prototype config --quiet
docker ps --format '{{.Names}} {{.Status}}'
```

**验收：** 测试与依赖检查退出 0；旧 Agent backend/frontend 已停止；WeKnoraAgent-app、ui、redis、neo4j 继续运行。若有差异，先记录现场，再局部修复，不能把已有实现视为不存在。

### 任务 1：纯 Agent 的结构及真实 HTTP 适配验证

**只在失败需要时修改：** `WeKnora-Agent/main.py`、`agent.py`。**测试：** `tests/test_agent.py`，必要时新增 `tests/test_http_mcp.py`。

- [ ] 将现有真实 SDK stdio 测试补一项 Streamable HTTP 测试；测试进程使用 SDK FastMCP 的原生 HTTP 传输，本机随机可用端口；结束关闭进程，不在生产增加 Web 服务。
- [ ] HTTP 服务暴露当前真实工具参数：read_document(knowledge_id)、query_knowledge_graph(knowledge_base_ids, query)。修正 fixture 的简化参数，保留它是测试数据的说明。
- [ ] 验证 headers 随 tools/list 和 tools/call 发送；缺配置在连网之前失败；密钥中引号和反斜线不破坏 JSON。
- [ ] 增加 tools/list 超时、全部工具不在只读范围、工具调用异常、recursion_limit 耗尽的回归测试。
- [ ] 检查 13 项核心只读名单是否在真实 tools/list 中完整可见。当前工厂只要求存在任意一个允许工具；原型验收必须严格核对完整能力，必要时仅加缺失工具名告警，不建能力管理系统。
- [ ] 增加真实延迟工具取消和模型等待超时测试，而不只用替换 build_agent 的 sleep 证明 timeout；进程结束验证 MCP 会话已释放。
- [ ] 对 CLI 错误只允许短小脱敏分类。不要添加千行异常归一化或自研 ToolMessage 包装。
- [ ] 检查生产 imports：只能是标准库、dotenv、LangChain provider、MCP adapter 和本项目 agent；不得引用 backend.app。

结构检查命令：

```powershell
Set-Location E:\GoLandCode\WeKnora-Agent
Get-ChildItem -Force | Select-Object Name
rg -n 'FastAPI|SessionStore|MCPClient\b|_BudgetedChatModel|backend\.app|evidence|sqlite|multipart|uvicorn' main.py agent.py requirements.txt
.\.venv\Scripts\python.exe -m pytest tests -q
```

`rg` 无匹配通常返回 1，属于此项的预期结果，不能当作测试失败。不要扫描 .venv 并把 SDK 自带服务器模块算成自研业务。

**验收：** HTTP 测试实际完成协议握手／发现／调用；两个生产文件保留；运行入口、README、依赖只指向纯 Agent。

本任务新加行为／修复统一先写能复现的测试并看见失败，再做最小修改，最后跑相关全套。已有正确功能的验收测试可直接通过，不为了“先失败”破坏已有实现。每项完成就记录结果与涉及路径；WeKnora 可按明确文件提交，不能捎带其他人的变更。

### 任务 2：WeKnora MCP 的权限与结构化错误

**修改：** `internal/middleware/mcp_endpoint_auth.go`、`internal/mcpscope/scope.go`、`internal/mcpserver/scope.go`、`scope_errors.go`、各 tools 文件和 server 注册。**复用测试：** `mcp_endpoint_user_identity_test.go`、`request_scope_test.go`。**新增测试：** `internal/mcpserver/tool_errors_test.go`。

- [ ] 先运行已有身份／范围测试，确认接手的实现状态。
- [ ] 从正常用户、端点、空间、选定 KB 构造范围矩阵；每个工具读取和写入都在实际 caller 范围执行。
- [ ] 将仍使用文本错误的 handler 分支转换为已有 errorResult；内部异常给脱敏消息与稳定码，服务日志保留诊断。
- [ ] 为检索、原文、Wiki、图谱、状态各加至少一项结构化错误断言；不仅断言英文文本包含 forbidden。
- [ ] 保持合法机器端点原有行为；用户模式不能降级机器。不能通过不发送 selection 绕过用户模式内容读取要求。
- [ ] 所选 A 时读取 B 的文档、同名 Wiki slug、图谱 KB、上传目标均失败，即使端点原本允许 A、B。

需要覆盖的矩阵：

| 输入／状态 | 预期 |
| --- | --- |
| token 不存在／失效／端点禁用 | 身份失败，未调用知识服务 |
| require_user_identity=true，但无 JWT／无成员依赖 | 拒绝，不能读取 owner 的资料 |
| JWT 过期／用户停用／成员资格撤销 | 拒绝 |
| X-Tenant-ID 与授权空间不一致 | 拒绝 |
| selection 为空、格式错误、超过 10 KB | 明确 INVALID_ARGUMENT 或选择错误 |
| 选定 KB 不在用户或端点范围 | 明确拒绝，不静默丢掉越权项后继续 |
| 同一用户有共享 KB 权限 | 按 owner 访问资源，caller 仍保留 |
| 同一关系／slug／文档直接 ID 越权 | 拒绝且不泄露原文／来源 |
| KB A 成功、KB B 真实服务故障 | 成功部分 + 明确 partial/errors，不能称全部完成 |

Go 结构化错误基础测试可直接加入新测试文件，完整 package/import 如下：

```go
package mcpserver

import (
    "encoding/json"
    "testing"
)

func TestStructuredOutOfScopeError(t *testing.T) {
    result := errorResult(outOfScope("outside selection"))
    if !result.IsError {
        t.Fatal("scope failure must set isError")
    }
    raw, err := json.Marshal(result.StructuredContent)
    if err != nil {
        t.Fatal(err)
    }
    var body struct {
        Error struct {
            Code string `json:"code"`
            Retryable bool `json:"retryable"`
        } `json:"error"`
    }
    if err := json.Unmarshal(raw, &body); err != nil {
        t.Fatal(err)
    }
    if body.Error.Code != CodeKBOutOfScope || body.Error.Retryable {
        t.Fatalf("wrong scope error: %+v", body.Error)
    }
}
```

该基础测试已有实现应通过；真正的回归测试须调用具体 handler 的失败分支，先见其缺少 structuredContent 的失败，再改生产代码。

验证命令（Linux／容器环境有 SQLite 依赖时）：

```sh
go test -tags sqlite_fts5 -count=1 ./internal/mcpscope ./internal/middleware ./internal/mcpserver ./internal/router
```

Windows 缺 CGO/SQLite 时使用第 11 节 weknora-check，不为通过测试删掉 FTS5 或知识图谱功能。

**验收：** 范围矩阵通过；所有知识工具失败可机器识别；客户端不计算权限、不复制错误注册表。

### 任务 3：服务自身的文件导入与处理状态

**修改／复用：** upload_transport、upload_staging、upload_repository、tools_import、tools_status 和已有 migrations。**新增离线脚本：** `examples/mcp-validation/scripts/import_corpus.py`。**现有测试：** upload_staging_test、upload_repository_test、tools_import_enqueue_failure_test。

- [ ] 先验证现有迁移和回执测试；不要另外在 Agent 建 SQLite 或暂存目录。
- [ ] 独立脚本从本地受限配置／环境获取调用身份，不接收密码命令行参数、不自己实现身份服务。
- [ ] 从 manifest 逐文档读取、校验 SHA256；按顺序 multipart 上传，保存服务 upload_id，调用 MCP import，再回填真实 knowledge ID。
- [ ] 相同 Idempotency-Key／相同字节回放原回执；相同 key／不同字节必须冲突；不同 key／相同字节的导入重复按现有去重契约记录。
- [ ] 并发相同 upload_id 只有一次领取；模拟响应丢失、过期租约恢复、导入失败、排队失败；记录 indexed_queued=false 与错误，不能成功包装。
- [ ] 验证只读用户不能上传／导入，其他用户、端点、空间不能复用 upload_id；共享 KB 写权限正确。
- [ ] 轮询真实文档状态，超时默认 300 秒；轮询采用 2、4、8 秒后保持 8 秒，过期退出非零，不无限重试。不能轮询出假的百分比。
- [ ] 内容可检索后回填 `weknora_document_id` 和 `imported_document_id` 为同一真实 ID，保存 KB、原文件 hash、状态、时间；原子替换 manifest，失败不要清空其他条目。

HTTP 暂存的最小示例（放独立导入脚本，不放 Agent）：

```python
import hashlib
from pathlib import Path
import httpx

def stage_file(url, headers, kb_id, file_path, action_key):
    path = Path(file_path)
    file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    with path.open("rb") as stream, httpx.Client(timeout=120) as client:
        response = client.post(
            url.rstrip("/") + "/uploads",
            headers={**headers, "Idempotency-Key": action_key},
            # Order is deliberate: authorize KB before streaming the file.
            files=[("knowledge_base_id", (None, kb_id)),
                   ("file", (path.name, stream, "application/octet-stream"))],
        )
        response.raise_for_status()
        receipt = response.json()["data"]
    if receipt["sha256"] != file_hash or receipt["knowledge_base_id"] != kb_id:
        raise ValueError("upload receipt does not match source")
    return receipt
```

这个示例只暂存。脚本还需通过 SDK call_tool 导入／查状态（第 9 节），并依据真实响应字段取知识 ID；不要猜响应固定叫 document_id。错误处理保存脱敏诊断，不把完整 Authorization 写到报告。

**验收：** 新文件能检索到原文，回放不重复创建；失败可恢复；数据由 WeKnora 自己管理。MD/TXT 主线达标，DOCX／文本 PDF 的结果分别记录。

### 任务 4：RAG 原文检索及完整性信号

**修改：** tools_retrieve.go；必要时 `internal/agent/tools/search_knowledge.go`、read_document.go 的返回元数据。**新增测试：** `internal/mcpserver/retrieval_completeness_test.go`。

- [ ] 验证 keyword、semantic、hybrid 三种路径使用现有 WeKnora 服务，缺模型／索引时返回明确错误，不能从 Agent 直接访问数据库或向量库。
- [ ] 检索返回实际 KB、knowledge、chunk、文本与可用分数；相同文档多 chunk 去重不能丢掉不同证据。
- [ ] 分别验证 list_documents 分页和 read_document 的 offset／next_offset／truncated；循环结束条件使用服务元数据，不能用“返回少于 limit”替代所有截断判断。
- [ ] 明确 search_knowledge 是 top-K 检索，当前没有承诺可遍历全部相关文档；grep_chunks 也是候选检索后正则过滤，不能把它称为全库穷尽 grep。
- [ ] 给检索结果补可判断的覆盖元数据：请求 scope、limit、返回数、已知 truncation、partial/errors；服务不知道总命中时标 unknown，不能伪造 total 或 complete=true。
- [ ] 真要找齐有限测试库：先 list_documents 完整分页，再对候选／必要文档 read_document，按下一 offset 读取所需原文。由标准 Agent 选择工具；不在客户端写固定“检索编排业务服务”。
- [ ] 构造超过一页、超过 top-K、同名多 KB、索引未就绪、精确编号、跨文档证据与冲突文档样例。

关键断言：

| 场景 | 断言 |
| --- | --- |
| 超过文档页大小 | 页之间无缺失、重复可去重、total 对得上 |
| 原文内容超过读取预算 | truncated=true，next_offset 能继续，不能隐藏未返回内容 |
| top-K 未找齐标注证据 | 记录遗漏，不将返回 10 条解释成只存在 10 条 |
| 未就绪或上游故障 | 错误／状态明确，不等同“没有相关文档” |
| 共享 KB + selection | 各 owner 下检索，但返回资料严格属于范围交集 |

**验收：** 所有返回证据能回到原文；Agent 与评估知道哪些结果有限；完整性最终由标注集验证，而不是服务声明自己 complete。

### 任务 5：Wiki 核心流程和来源

**修改：** tools_wiki.go、types/wiki_page.go；仅在来源持久数据不足时修改现有 Wiki service/repository。**新增测试：** `internal/mcpserver/wiki_provenance_test.go`。

- [ ] 验证 Wiki 未启用、生成中、生成失败、可浏览状态分别可识别。
- [ ] 完整执行 wiki_index → wiki_search → wiki_read_page → wiki_list_pages；同名 slug 指定 KB，跨库不误读。
- [ ] 验证 Wiki 多来源来自真实页面生成记录；每条 source_refs_v2 使用实际 KB、knowledge 和 chunk/quote，不能把所有 KB 统一填成请求 KB。
- [ ] 若现有页面 source_refs 只有文档 ID，通过服务侧授权读取补来源；无法核验的旧页保留 unknown／unverified_source，不在 Agent 用标题猜测。
- [ ] 验证页面列表分页、目录截断、被删除／失权来源、冲突原文；引用不能“存在 ID 就算准确”。
- [ ] 验证 wiki_graph 的边是页面链接，只能回答页面／主题链接问题；输出明确 graph_type=wiki_links 或现有等价语义。

**验收：** 页面可浏览、搜索、读到正文，至少一个多文档综合页的来源逐条可核验；Wiki 链接图不能冒充实体关系图。

### 任务 6：实体知识图谱的真实关系和出处（P0）

**修改：** `internal/mcpserver/tools_graph.go`、`internal/types/extract_graph.go`、`internal/agent/tools/query_knowledge_graph.go`、`internal/application/repository/retriever/neo4j/repository.go`；关系提取组装处以实际 GraphData 写入链路定位。

**新增测试：** `internal/mcpserver/graph_provenance_test.go`、`internal/application/repository/retriever/neo4j/provenance_test.go`；复用图谱业务工具测试。

已查到的具体问题，不能当作已完成：

1. tools_graph.go 的 enrichGraphEdgesWithSourceRefsV2 把本次 query 的全部 evidence chunks 分配给每一条 edge。范围正确不等于关系出处正确。
2. 该函数按整批是否存在 quote 决定全部引用的 verified，可能把没有原文的来源也标为已核验。
3. GraphRelation 已有 ID/SourceID/TargetID，但缺 relation 自身的知识／chunk 出处；Neo4j 目前保存节点 chunks，关系创建未持久逐关系 chunk。
4. query_knowledge_graph 聚合时按 `Node1 + Type + Node2` 去重，关系显示名相同但来自不同文档／KB 的实例可能被合并；输出 relationData 仅显示名，丢失真实 relation ID。

最小修正先保证诚实，然后补可追溯：

- [ ] 先加两条关系来自两篇不同文档的回归样例，证明当前所有边同引用的问题。
- [ ] 无法确定逐关系出处时返回 unknown，移除“把所有命中 chunk 视为所有边的证据”的 fallback。原型可以显示关系，但不得错误标 verified。
- [ ] 为内部 GraphRelation 增量保存真实 knowledge_id、chunk IDs 等关系出处；新关系在生成／写 Neo4j 时保存，读取恢复。不要依靠 source/target 名称猜 ID。
- [ ] 出处由文档／chunk 处理上下文与 NameSpace 绑定，不能由抽取模型任意生成。提取结构、内部来源字段和展示 JSON 的兼容性分别检查；现有格式的旧关系读取时缺字段应兼容 unknown。
- [ ] 关系唯一键包含 KB + knowledge + relation identity；同名实体、同名同类型关系在不同文档保留来源实例，展示合并不抹掉来源列表。
- [ ] 在业务工具聚合和 graph_data／local_graph 输出保留这些真实身份；MCP 按该关系自己的 chunk IDs 授权读取并补 quote。
- [ ] 来源必须属于该关系实际 KB／knowledge，且处于当前授权范围；不能用另一关系的 quote 填充。每条 SourceRefV2 单独判 provenance_status。
- [ ] 老关系缺出处字段不从所有检索结果回填，标 unknown；只在测试库显式重建这些文档图谱，禁止批量重写生产图谱。
- [ ] Neo4j 断连、图谱配置关闭、缺抽取类型、多 KB 部分失败、关系上限截断分别测试。不能用静态节点数据通过真实图谱验收。

现在就能暴露问题的测试（使用当前实际 helper 签名，完整代码）：

```go
package mcpserver

import (
    "testing"
    "github.com/Tencent/WeKnora/internal/types"
)

func TestUnmappedGraphEdgesMustNotClaimAllQueryEvidence(t *testing.T) {
    kbID := "00000000-0000-0000-0000-000000000001"
    data := map[string]interface{}{
        "results": []interface{}{
            map[string]interface{}{"chunk_id": "c1", "knowledge_id": "d1", "knowledge_base_id": kbID, "content": "A 负责 B"},
            map[string]interface{}{"chunk_id": "c2", "knowledge_id": "d2", "knowledge_base_id": kbID, "content": "C 依赖 D"},
        },
    }
    first := map[string]interface{}{"id": "r1", "source": "A", "target": "B"}
    second := map[string]interface{}{"id": "r2", "source": "C", "target": "D"}
    view := map[string]interface{}{"edges": []interface{}{first, second}}
    enrichGraphEdgesWithSourceRefsV2(data, view, []*types.KnowledgeBase{{ID: kbID}})
    for _, edge := range []map[string]interface{}{first, second} {
        refs, ok := edge["source_refs_v2"].([]types.SourceRefV2)
        if !ok || len(refs) == 0 {
            t.Fatal("unmapped edge must explicitly expose unknown provenance")
        }
        for _, ref := range refs {
            if ref.ProvenanceStatus != "unknown" || ref.KnowledgeID != "" || len(ref.ChunkIDs) != 0 {
                t.Fatalf("unmapped edge borrowed query-wide evidence: %+v", ref)
            }
        }
    }
}
```

该测试目标是无映射不得借用全局 evidence；如果 helper 重构，保留此行为并调整调用。随后加两项有确切映射的测试：r1 只引用 d1/c1，r2 只引用 d2/c2；另加一个无 quote 条目不得随其他条目变 verified。

**验收：** 真实 Neo4j 查询返回关系身份、方向、出处；至少两条不同关系的原文分别核验；截断／partial 可识别；unknown 不得算引用支持通过。

### 任务 7：真实 WeKnora + 实际模型的标准 Agent 问答

**配置：** Agent `.env`／mcp.json；**新增服务自检：** `examples/mcp-validation/scripts/mcp_smoke.py`。生产 Agent 结构不变。

- [ ] 在 WeKnora UI 配置实际可用 chat/embedding 模型、测试 KB、Wiki 和实体图谱；模型负责生成/索引，Agent 模型负责最终问答，配置归属不能混淆。
- [ ] 由调用方取得有效用户 JWT、端点 token、空间与 KB；缺少时清楚报告阻塞项，不使用内置管理员、旧 token 或伪造身份替代验证。
- [ ] 先通过原生 MCP SDK 检查 tools/list 及真实 inputSchema；直接调用一个检索、原文、Wiki、图谱工具。
- [ ] 端点配置必须包含第 7.3 节全部 13 项 Agent 只读工具；缺项判配置验收失败，即使当前工厂仍能运行。工具存在与 KB 是否已配置其能力分开记录。
- [ ] 再运行 CLI 的实际模型问题，保留标准消息／工具事件、最终答案、实际来源。不是固定测试模型，不是模拟 MCP 响应。
- [ ] 各跑一题：原文事实、跨文档综合、Wiki 概览、实体关系、无答案。模型根据问题选工具，不强制每题都调用全部工具。
- [ ] 模型遇到工具错误明确表达证据不足；原生递归上限／超时非零退出。换模型仅改配置后复跑一题。
- [ ] 记录真实模型名称、服务镜像／源码版本、时间、延迟、工具数；不保存密码或 token。

真实模型执行命令：

```powershell
Set-Location E:\GoLandCode\WeKnora-Agent
.\.venv\Scripts\python.exe main.py --mcp-config mcp.json --question "根据原始文档、Wiki 和实体图谱，说明云雀平台项目负责人、依赖关系和支持这些结论的原文"
```

**验收：** 实际调用工具，答案可以逐条回到服务原文。此项只证明端到端能运行，不替代十二题准确性评估。

### 任务 8：离线评估，不增加 Agent 业务层

**新增：** `examples/mcp-validation/scripts/run_eval.py`、`score_eval.py`、`tests/test_eval_metrics.py`。**读取：** corpus/manifest、questions/demo-12.json 和标准 Agent raw messages。

- [ ] 确认十文档全部有真实知识 ID、正确 hash、可读取状态；否则非零退出，不能用 doc01 等逻辑 ID 当服务 UUID。
- [ ] 用当前十二题：单文档 3、跨文档 3、Wiki 2、实体关系 2、无答案 2；保留 relevant_documents、required_evidence、expected_facts。
- [ ] 加任务 2/4/6 的边界案例为单独测试组，不用挤占或改写原十二题分母。
- [ ] 每题独立问题／Agent 状态，固定模型、temperature=0、scope 和单题 timeout；不跨题共享缓存或证据。
- [ ] 跑两个策略：单次 hybrid 检索 top-10 + 一次同模型资料问答；标准 Agent 自主工具调用。两者使用同样身份、模型、知识范围和题库。
- [ ] 基线不能通过 Agent 重新检索，否则不是单次检索基线。基线也不能绕过 MCP 直接查询数据库。
- [ ] 记录未经改写的 AIMessage 工具调用、ToolMessage content/artifact/status、SDK 事件和最终 AIMessage。序列化用框架 model_dump，读取结构不得引入生产归一化模块。
- [ ] 仅把来源 ID、读取到的证据、工具数、状态等用于机器统计；事实准确、事实完整和引用支持通过逐事实人工复核。
- [ ] 报告未知／超时／权限故障／工具异常，不删除失败题，不把失败当无答案命中。
- [ ] 输出 runs.jsonl、manual-review.json、report.md，包含分子分母、未找齐文档、错误、原文链接／标识、人工评分人与时间；人工复核未完成时准确性为 not_evaluated。

指标：

| 指标 | 定义 | 首轮门槛 |
| --- | --- | --- |
| 文档 recall | 每题实际发现的标注相关文档数 / 全部标注相关文档数 | 可回答题宏平均 ≥ 90% |
| 文档找齐率 | 找齐全部相关文档的可回答题数 / 可回答题数 | ≥ 80%，即至少 8/10 |
| 必需证据 recall | 工具实际返回并读到的必需证据数 / 标注必需证据数 | 宏平均 ≥ 90%，同时显示各题缺失 |
| 事实准确率 | 人工判正确的输出事实数 / 可核验输出事实数 | ≥ 95% |
| 事实完整率 | 答案覆盖的必要事实数 / 标注必要事实数 | ≥ 90% |
| 引用支持率 | 原文确实支持该陈述的引用数 / 全部引用数 | ≥ 95%；unknown 不算支持 |
| 无答案处理 | 两题明确不足且没有编造事实／引用 | 2/2 |
| 权限边界 | 未授权内容／ID／quote 无泄漏 | 全部边界样例通过 |

文档“发现”和原文“读取”分开：搜索只返回 ID 可以计 document recall，但不能计证据 recall。Wiki／图谱的 source_refs 只有 ID、没有原文支持时，不算证据已读。只有有效 ID 不等于正确引用。

无答案题 relevant_documents 为空：recall 标 N/A，不记 100%，不混入可回答题平均。可回答题没输出事实时准确率 N/A、事实完整率 0，不以空答案获得高准确率。样本必须给出实际数量，95% 比例在小分母下可能意味着所有项正确。

指标测试的最小例子：

```python
def test_document_recall_and_all_found_are_distinct():
    from scripts.score_eval import document_metrics
    result = document_metrics({"d1", "d2"}, {"d1", "d3"})
    assert result == {"matched": 1, "required": 2, "recall": 0.5, "all_found": False}

def test_no_answer_question_is_not_perfect_recall():
    from scripts.score_eval import document_metrics
    result = document_metrics(set(), set())
    assert result["recall"] is None
    assert result["all_found"] is None
```

对应的最小统计函数（仅离线 score_eval.py）：

```python
def document_metrics(required, found):
    required, found = set(required), set(found)
    matched = len(required & found)
    return {"matched": matched, "required": len(required),
            "recall": matched / len(required) if required else None,
            "all_found": required <= found if required else None}
```

**验收：** 十二题有真实运行轨迹和人工核验；不足项按工具链路定位回 WeKnora，不能用关键词命中率冒充答案准确率。

### 任务 9：前端复用、最小展示与完整交付

**复用：** `WeKnora/frontend/src/views/knowledge/KnowledgeBase.vue`、`wiki/WikiBrowser.vue`、`views/chat/index.vue`、`views/chat/components/tool-results/GraphQueryResults.vue`、现有 MCP settings/API。

- [ ] 验证 WeKnora UI 文档上传／状态／原文阅读、AI 问答与检索来源、Wiki 浏览、Wiki 链接图和实体关系结果。
- [ ] 知识页 graph tab 当前是 Wiki 页链接图；实体关系采用 GraphQueryResults 等现有展示，不把两种图合并成同一语义。
- [ ] 若现有展示遗漏关系来源、截断或部分失败，最小增量修改 WeKnora 前端及其现有 API 类型。新页面／组件也归 WeKnora，不能恢复 WeKnora-Agent/frontend。
- [ ] 原型的纯 LangChain Agent 以 CLI 验证。WeKnora UI 自带 AI 问答是已有服务链路，不宣称它已经改为调用这个 CLI Agent。
- [ ] 后续若要求主产品 UI 使用 LangChain，主产品服务直接调用纯 Agent 库函数或其宿主；Web 入口、用户会话、流式传输由主产品负责。该集成不在本阶段另造 Agent Web 项目。
- [ ] 保存运行 README、env 变量说明、服务 schema 实测摘要、部署方式、评估报告和明确未完成项。
- [ ] WeKnora 只暂存本次明确修改的路径，提交前检查差异；不要 `git add .` 把秘密／其他人的代码一起提交。Agent 非 Git 仓库用文件清单／hash 交付，不虚构 commit。

前端确有改动时执行：

```powershell
Set-Location E:\GoLandCode\WeKnora\frontend
npm ci
npm run type-check
npm run build
```

相关现有测试使用 package.json 的 `tsx --test` 运行；只跑修改对应组件／工具引用解析的测试，不因为计划里有前端就重做全部页面。

**验收：** 用户可通过既有 UI 管理和浏览核心知识，Agent 保持纯框架；交付报告区分已有 UI、纯 Agent 验证和将来的主产品接入。

## 9. 原生 SDK 自检示例

以下完整示例可作为未来 mcp_smoke.py 的起点，验证当前实际 WeKnora，不引入自研 MCPClient。需在运行前设置 TEST_KNOWLEDGE_ID 和 TEST_WIKI_SLUG；它们必须来自本次测试库。

```python
import asyncio
import json
import os
from pathlib import Path
from dotenv import load_dotenv
from langchain_mcp_adapters.client import MultiServerMCPClient

def need(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError("missing environment variable: " + name)
    return value

async def verify():
    agent_root = Path(os.environ.get("WEKNORA_AGENT_DIR", "E:/GoLandCode/WeKnora-Agent"))
    load_dotenv(agent_root / ".env", override=False)
    kb_ids = [item.strip() for item in need("WEKNORA_KB_IDS").split(",") if item.strip()]
    connection = {"transport": "streamable_http", "url": need("WEKNORA_MCP_URL"),
                  "headers": {"Authorization": "Bearer " + need("WEKNORA_MCP_TOKEN"),
                              "X-WeKnora-User-Token": need("WEKNORA_USER_TOKEN"),
                              "X-Tenant-ID": need("WEKNORA_WORKSPACE_ID"),
                              "X-WeKnora-Knowledge-Base-Ids": ",".join(kb_ids)}}
    client = MultiServerMCPClient({"weknora": connection})
    calls = [
        ("list_knowledge_bases", {}),
        ("search_knowledge", {"query": "云雀平台", "mode": "hybrid", "knowledge_base_ids": kb_ids}),
        ("read_document", {"knowledge_id": need("TEST_KNOWLEDGE_ID"), "limit": 5}),
        ("wiki_read_page", {"slug": need("TEST_WIKI_SLUG"), "knowledge_base_id": kb_ids[0]}),
        ("query_knowledge_graph", {"knowledge_base_ids": kb_ids, "query": "项目负责人"}),
    ]
    async with asyncio.timeout(120):
        async with client.session("weknora") as session:
            listed = await session.list_tools()
            available = {tool.name for tool in listed.tools}
            if any(name not in available for name, _ in calls):
                raise RuntimeError("required tools missing from endpoint")
            # Record schemas only; never record connection headers.
            schemas = {tool.name: tool.inputSchema for tool in listed.tools}
            print(json.dumps({"schemas": schemas}, ensure_ascii=False))
            for name, args in calls:
                result = await session.call_tool(name, args)
                if result.isError:
                    raise RuntimeError("MCP tool failed: " + name)
                print(json.dumps({"tool": name, "result": result.model_dump(mode="json", by_alias=True)},
                                 ensure_ascii=False))

if __name__ == "__main__":
    asyncio.run(verify())
```

该示例 stdout 包含测试库原文，只保存到受限 eval/reports，不分享真实秘密资料。完整脚本需对输出目录、调用失败状态和正／负用例加入独立测试。将其保存至方案指示路径后再执行；本次仅给出方案，没有创建或运行这个脚本。

## 10. 需要补充的最少信息与默认选择

接手模型先检查已有本地配置，确认缺什么再一次性向用户补充：

| 信息 | 用途 | 默认／替代处理 |
| --- | --- | --- |
| 支持工具调用的模型名、base URL、密钥 | 真实 Agent 问答 | 没有则完成结构和 SDK 测试，报告真实模型验证阻塞；不能伪造完成 |
| WeKnora 登录身份／有效 JWT | 用户权限验证 | 密码由本地受限配置或安全输入提供，不放命令行／文档 |
| 端点 token、工作空间、测试 KB IDs | MCP 范围 | 使用隔离原型，不操作用户其他库 |
| 可用于测试的资料或是否沿用演示十文档 | 准确性评估 | 默认沿用已保存的演示语料 |
| 部署是否可重建当前原型镜像 | 让源码修复生效 | 用户当前任务授权修复测试原型；保留原数据，不删除卷或重建原正式环境 |

架构、框架、目录归属、是否保留 Wiki／图谱已确定，不重复向用户提问。默认使用标准 create_agent、现有 WeKnora UI、单 Agent、CLI、现有隔离 WeKnora 栈。

## 11. 完整检查命令与预期

### 11.1 Agent

```powershell
Set-Location E:\GoLandCode\WeKnora-Agent
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -m pytest tests -q
.\.venv\Scripts\python.exe main.py --help
```

预期：安装和依赖检查退出 0、全部测试通过、help 展示 question/mcp-config/env-file。当前基线七项；新增测试后不能继续报告固定“7 项”代表全覆盖。

### 11.2 WeKnora 代码检查和原型运行

```powershell
Set-Location E:\GoLandCode\WeKnora\examples\mcp-validation
$composeArgs = @('-p', 'weknora-agent-prototype', '-f', 'deploy/compose.prototype.yml', '--env-file', 'deploy/.env.prototype')
docker compose @composeArgs config --quiet
docker compose @composeArgs run --rm --build weknora-check
```

预期：config 无错误；check 镜像能完整编译且列出的包测试通过。检查脚本为 `WeKnora/scripts/weknora-check.sh`；它默认覆盖 mcpserver、middleware、service、sqlite retriever、router、types。新增 mcpscope/Neo4j/graph tool 测试另加入包名单，不能因默认 runner 未包含而漏检：

```powershell
docker compose @composeArgs run --rm --build -e 'WEKNORA_CHECK_PKGS=./internal/mcpscope ./internal/mcpserver ./internal/middleware ./internal/router ./internal/types ./internal/application/service ./internal/application/repository/retriever/sqlite ./internal/application/repository/retriever/neo4j ./internal/agent/tools' weknora-check
```

服务源码修复后，让当前测试实例使用新镜像：

```powershell
docker compose @composeArgs build weknora
docker compose @composeArgs up -d redis neo4j weknora weknora-ui
```

Compose 服务名是 weknora 等，实际容器仍沿用 WeKnoraAgent-app/ui/redis/neo4j；名称是历史遗留，不代表 Agent 又有后端服务。不要用旧 deploy 路径、不要启动 backend/frontend、不要 down -v。若修改 WeKnora 前端，当前 release UI 镜像不会自动包含源码改动，必须使用该仓库前端构建方式生成匹配 UI 镜像并更新本测试栈的 WEKNORA_UI_IMAGE。

### 11.3 服务自检和评估（脚本实现后）

脚本的命令行契约固定如下，接手者按任务实现后执行；当前这些命令不能直接当成已有工具运行：

```powershell
Set-Location E:\GoLandCode\WeKnora\examples\mcp-validation
$agentPython = 'E:\GoLandCode\WeKnora-Agent\.venv\Scripts\python.exe'
& $agentPython scripts/mcp_smoke.py --agent-dir E:\GoLandCode\WeKnora-Agent --output-dir eval/reports/mcp-smoke
& $agentPython scripts/import_corpus.py --agent-dir E:\GoLandCode\WeKnora-Agent --manifest eval/corpus/manifest.json --knowledge-base-id $env:WEKNORA_TEST_KB_ID
& $agentPython scripts/run_eval.py --agent-dir E:\GoLandCode\WeKnora-Agent --manifest eval/corpus/manifest.json --questions eval/questions/demo-12.json --strategy both --output-dir eval/reports
& $agentPython scripts/score_eval.py --runs eval/reports/runs.jsonl --manual-review eval/reports/manual-review.json --output eval/reports/report.md
```

第 9 节仅是 smoke 起点：此处 agent-dir/output-dir 等 argparse 选项应由接手模型按本契约补齐，不宣称示例本身已经支持它们。离线脚本需要额外依赖时单独放在 mcp-validation/requirements-dev.txt；Agent runtime requirements 不添加 openpyxl、办公格式处理或评测平台。

## 12. 完成标准与交付模板

所有相关任务按其验收通过后才能称“最小核心流程跑通”。满足以下检查表：

- [ ] Agent 无旧应用目录和业务代码，使用原生 SDK/框架，无自建 HTTP 服务。
- [ ] MCP 实际 tools/list 与文档契约匹配，标准 HTTP 客户端可直接调用。
- [ ] 用户／端点／空间／KB 范围交集生效，直接 ID 访问不绕过权限。
- [ ] 暂存、导入、幂等恢复、状态、原文检索实际通过。
- [ ] 原文分页和截断可识别，top-K 没有冒充全量召回。
- [ ] Wiki 核心工具与多来源核验通过。
- [ ] 实体关系来自真实 Neo4j；逐关系来源准确，未知明确；不是 Wiki 链接图。
- [ ] 真实模型实际调用工具；来源回读支持答案；至少可替换一个模型配置复跑。
- [ ] 十二题及边界组完整记录，人工评分完成或明确标 not_evaluated。
- [ ] 评估／部署在 WeKnora 验证目录，旧秘密配置不会出现在提交／报告。
- [ ] 文档与实测一致，清楚列出失败、未验证与后续补充。

交付报告使用以下内容，按实测填写，不只给“已完成”一句话：

```text
代码状态：纯 Agent 是否保持，WeKnora 本次修改的具体路径与原因。
服务状态：实际镜像／源码版本、MCP 端点能力、KB 配置和生成状态。
验证证据：执行命令、时间、退出码；结构、权限、上传、RAG、Wiki、图谱、实际问答各项结果。
评估：每个指标分子／分母、遗漏资料、错误题、人工复核情况和报告路径。
限制：缺少的凭据／尚未验证的格式／unknown 来源／未达标指标。
文件：运行 README、当前方案、原始轨迹和评估报告的可点击路径。
```

给执行模型的开场指令可直接复制：

```text
阅读 E:/GoLandCode/WeKnora-Agent/docs/implementation-plan.md，按任务 0～9 执行。
用户要求 WeKnora-Agent 只有标准 LangChain create_agent、MCP 配置和 CLI；业务全部在 WeKnora，Wiki 与实体图谱均为核心功能。
纯 Agent 裁剪已经完成，不要恢复 frontend/backend、登录会话、自研 MCP/runtime、证据 Registry 或评测平台。
先确认当前修改和测试，不覆盖 WeKnora 中其他人未提交的代码。优先补结构化错误、权限范围和真实逐关系来源，再跑上传、检索、Wiki、图谱及实际模型链路。
离线评估只放 WeKnora/examples/mcp-validation。用真实 ID 和原文证据计算找齐率／召回，人工核验事实准确与引用支持。
明确区分已实现、已验证、待验证；遇缺少模型凭据或用户 JWT 时只请求具体缺项，并继续其他可完成任务。不得用预设模型或模拟图谱宣称真实链路通过。
```
