# 原生智能体管理与问答选择

> 2026-10-21 最新交接：用户要求改为交付方案，由其他模型继续执行。请优先阅读 [收口执行方案](superpowers/plans/2026-10-21-native-agent-mcp-finalization.md)。**收口已完成，最终结果见文末"收口执行结果"一节。**

## 核对结论

本轮前，MCP `ask` 已支持 `quick-answer`、`smart-reasoning`、知识库范围、会话，以及端点发布的默认 `profile_id`。`profile_id` 不是完整的原生智能体目录，不能据此声称已经提供智能体创建或自由选择。工作台只显示内置问答模式，管理链路确实缺失。

用户要求补齐原生智能体管理与选择，因此在既有知识主链和 Wiki 工作区之外增加聚合工具 `agent_workspace`，而非把每个增删改接口拆成单独工具。核心面共七个工具。

## 资源和职责

- “智能体”指 WeKnora 的 CustomAgent 业务资源，配置和权限持久化仍在 WeKnora。
- 工作台通过 MCP 展示列表、创建、编辑、复制、删除，以及在问答中选择。
- LangChain CLI 继续保持模型与 MCP 适配器结构，不新增本地智能体数据库、执行调度、登录代理或 WeKnora 业务 REST 客户端。
- 模型默认只获得原有只读知识检索工具；智能体和 Wiki 的写入由用户按钮显式发起。

## MCP 契约

`agent_workspace` 的动作：`list/get/create/update/delete/copy`。参数为 `agent_id/name/description/config`；目录返回 `{agents:[...]}`，单资源返回 `{agent:...}`，删除返回 `{deleted:true}`。

配置限于知识问答相关字段：运行模式、知识问答类型、系统提示词、模型标识、默认选库方式、默认知识库，以及是否仅提及时检索。模型密钥、第三方 MCP、沙箱、网络、技能和其他已裁剪能力不通过该工具重新开放。既有资源更新必须保留未编辑的原生字段；输出使用安全字段视图。

`ask.agent_id` 表示显式选择原生智能体，与 `mode`、`profile_id` 互斥。该能力必须额外取得端点的 `agent_workspace` 许可，并通过原生可见性校验；保留原有 `profile_id` 的端点发布限制。原有问答权限、端点/用户知识库授权与请求范围仍生效。

切换范围、模式或指定智能体后须开启新会话，使在途旧回答失效。服务端仍校验最终选库、智能体和会话绑定，不能靠客户端状态代替授权。

## 界面

新增“智能体管理”页面，提供原生资源目录、配置查看、创建/编辑、复制、删除和进入问答；内置资源只读，可复制为自定义资源。

问答保留知识库多选；“指定智能体”模式下选择可见的原生智能体，发送 `agent_id`，不将 UI 用的占位模式值当作服务器 `mode` 发送。

## 验证与已知环境

需要验证目录与管理 CRUD、越权拒绝、配置白名单、显式选择不被默认智能体覆盖、不同智能体/范围续用会话的拒绝，以及 UI 身份和请求失效处理。真实验收使用临时智能体，完成后删除，不改已有智能体。

原生智能推理对模型配置的要求仍由 WeKnora 决定。此前本机缺少 Rerank 模型的限制不能用模拟成功掩盖。最终完成情况与测试结果待验收后补记。

## 实现后的复核与修正

- `ask.agent_id` 的授权解析结果通过私有 context 传给原生执行层，避免再次解析成端点默认智能体；返回的 agent_id 和会话绑定均使用真正执行的智能体。
- 显式智能体单独遵循原生 `none/selected/all` 与“仅提及时检索”语义。未显式选库时按智能体默认范围与端点、请求范围求交集；明确选择知识库时以请求覆盖默认，仍须授权。空范围同时钉在运行时配置中，避免下游再次扩展。
- 原本非空的工具白名单若过滤后不剩任何知识问答工具，明确拒绝，避免原生空白名单回退到默认检索工具。运行时克隆配置，不改已有智能体的持久化设置。
- 保存智能体配置后，指定智能体问答自动重开会话、丢弃旧流；快速和智能推理的独立会话不受影响。
- 新建与清空模型 ID 时填入当前工作空间的默认模型；模型 ID 必须属于当前工作空间且类型正确。缺少必要的模型配置明确失败。

本轮已独立确认前端 102 项、Python 71 项测试通过。Linux `sqlite_fts5` 全部 MCP server/types 包测试通过，Wiki 服务版本守卫回归通过，相关 Go vet 通过。真实页面验收及最终镜像部署结果将在下节补记。


## 真实页面验收（2026-10-21）

已在本机工作台 `http://127.0.0.1:18100`，使用当前账号及工作空间 2 的实际 MCP 端点验收。端点权限通过 WeKnora 正式管理 API 增加，不直写数据库。`tools/list` 返回且仅返回上述七个聚合工具。

- 列表显示原有 5 个智能体，含内置只读项和既有自定义项。
- 页面新建临时文档问答智能体，指定核心验收库、自定义提示词；编辑名称，并将模型 ID 清空后保存，服务端正确补回当前空间默认模型。
- 页面复制成功，得到独立副本。
- 指定新建智能体并明确选择知识库后，实际请求只有 `agent_id` 和 `knowledge_base_ids`，不混入 `mode/profile_id`。回答正确说明项目 A 负责人张三及实施协调、上线审批、运行维护职责，引用 `负责人.md`，并包含自定义提示词要求的“原生智能体验收成功。”。返回的 agent_id 与选中资源一致、知识库集合只有目标库。
- 将同一智能体改为“不检索知识库”，保存后页面 session 立即清空；选择“不额外收窄”后再次提问，响应知识库集合为空、引用为空，明确说明没有资料，没有沿用上一问张三的答案。
- 管理详情的“用此智能体问答”跳转已实际点击验证：进入指定智能体模式，选中正确 ID，保留既有问答范围并开启新会话。
- 原生 Wiki 页可打开编辑器后取消；链接图显示实际 5 页、13 条链接。验收库仍为 10 文档、244 分块、90 Wiki 页，本轮没有修改原有文档或 Wiki 正文。

上述问答也抓到模式回显缺陷：选定智能体时仍回显 endpoint-default。已补充先失败后通过的回归，改为返回智能体自身 quick-answer / smart-reasoning；同 ID 改模式也拒绝续用旧会话。修复后最终镜像和临时智能体清理结果待下节补记。


## 最后一轮部署的环境阻塞

模式回显补丁的完整 MCP/types 回归再次通过（7.934s / 1.740s，日志 `WeKnora/.planning/2026-10-21-wiki-workspace/go-mcp-types-mode-final.log`），前端最终为 102 项通过、Python 为 71 项通过。新增页面和前述真实 CRUD/问答均已在包含七工具的镜像上完成；**最后的模式回显补丁尚未部署**。

重建期间检测到另一进程也在执行 `docker build --platform linux/amd64 ... -t weknora-ui:local frontend/`。随后 Docker Engine 的 inspect/stop 请求均返回 500，WSL 诊断也超时（0x8007274c）。已仅停止本轮拥有的 compose build 进程以避让，没有停止另一构建、没有重启全局 Docker/WSL。

尚待运行环境恢复后的检查：

1. 使用原生产构建标记 `anydoc,sqlite_fts5` 重建并部署最后模式回显修复，重新发起指定智能体问答，断言返回实际 quick-answer 模式、正确 agent_id 与知识库集合，并检查页面智能体名称。
2. 智能推理的最新实测请求尚未完成，不能声称此模式真实验收通过。此前缺少 Rerank 的环境记录保留，恢复后应单独复测，避免和构建竞争资源。
3. 删除本轮两个临时智能体，确认原有 5 个资源保留：`2ce29852-0f34-4927-8c3f-82b2b0e23fb2`（MCP页面验收-1792568990940-已编辑）、`75ea5c3a-97ac-4eb0-8429-d81eb8412f9c`（同前缀副本）。本轮没有改既有自定义智能体。
4. 检查 DocReader 运行状态。为释放构建资源发出的 stop 请求返回 500，**未确认停止成功**；验收结束须确保恢复 PDF 解析服务。

真实正例和空范围反例的原始脱敏证据已保存在 Agent `.planning/2026-10-21-wiki-workspace/native-agent-live-evidence.json`，不含 token。上文提到的临时 Wiki 页面已在此前通过页面删除并验证不可读；本轮临时智能体由于 Docker 不可达仍待清理。


## 收口执行结果（2026-10-21 傍晚，按收口方案 Task 0–5）

### 模式回显补丁的部署确认（Task 1/2）

- 源码核对：`core_ask.go` 显式 agent_id 解析成功后 `plan.Mode = agent.Config.AgentMode`，执行走私有已解析计划；`TestCoreAskExplicitAgentIsAuthorizedAndActuallyExecutes` 与 `TestCoreAskExplicitAgentModeChangeRefusesSessionReuse` 在位。本轮未改任何 Go 源码。
- **无需重建**：`weknora-agent-app:local` = `53e82f05b50f`，构建于 2026-10-21 16:22:06 +0800，晚于 `internal/` 全部 Go 源文件最后修改时间（15:53）；`WeKnoraMCP-app` 容器运行该镜像（ID 一致）。镜像含七工具与模式回显补丁，由活栈行为证实：指定智能体问答返回 `mode: quick-answer`（智能体自身模式，不再是 endpoint-default），页面身份行显示「智能体 MCP页面验收-…-副本 · 模式 quick-answer · 范围 1 库」。本轮未执行新的镜像构建，`anydoc,sqlite_fts5` 生产标签未动。

### 活栈真实验收（Task 3/4，端点 cc7eb833，库 54281b47）

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 七工具目录 | pass | `tools/list` 恰好 7 个：agent_workspace/ask/ingest_document/knowledge_base/read_document/search_knowledge/wiki_workspace；页面同显 7 个工具 |
| 指定智能体 + 显式选库 | pass | 请求仅 agent_id+knowledge_base_ids；回答张三+实施协调/上线审批/运行维护，引用负责人.md，含标记；返回 agent_id 一致、mode=quick-answer、集合仅目标库 |
| 智能体默认范围 | pass | 不传显式选库时集合=智能体默认 [54281b47]，未扩大到全库 |
| 不检索 | pass | update 改 none 后集合为空、引用为空、明确说明无资料、未提张三 |
| 会话失效 | pass | 换智能体复用旧 session 被拒（bound to a different answering configuration）；同 ID 改模式复用被拒（bound to a different mode） |
| 智能推理 | **环境受限** | `failed to answer: rerank model is not configured: please set rerank_model_id on the agent`；工作区仍无 Rerank 模型，未降级为快速问答算通过 |
| 页面管理行为 | pass | 内置只读（编辑/删除禁用、复制可用）；自定义四操作可用；「用此智能体问答」预选正确 ID；切换智能体请求不带旧 session |
| Wiki 编辑器与链接图 | pass | 打开编辑器后取消；链接图跳转 17 页/74 链接 |

页面请求抓包：`/api/ask` 载荷仅含 `question`+`agent_id`（范围选「全部可用（不额外收窄）」时不带 knowledge_base_ids），无 `mode`/`profile_id`。

标记随机性说明：自定义提示词要求的「原生智能体验收成功。」在部分回答中未出现；A/A 对照（同智能体直连 MCP 同问题 2 次）同样缺失，确认是模型生成随机性而非页面或链路缺陷。前两轮直连验收回答均含标记。

### 临时资源清理与服务状态（Task 5）

- `2ce29852-0f34-4927-8c3f-82b2b0e23fb2`（MCP页面验收-1792568990940-已编辑）、`75ea5c3a-97ac-4eb0-8429-d81eb8412f9c`（同前缀副本）均按 ID+前缀双重核对后 `agent_workspace.delete`，各返回 `{deleted:true}`；重新 list 恰好 5 项：四个内置 + `b4572f55-1dee-43b8-ab9b-9e5c4bf5caa5`（我的RAG 问答）。
- 验收库 54281b47 计数不变：10 文档、244 分块、90 Wiki 页（链接图实测 90 节点/328 边）。
- 服务：app/docreader/redis/neo4j 均 healthy，UI up，工作台 18100 正常。回归：Node 102 通过、pytest 四文件 71 通过（本轮复核）。

### 剩余限制

- 智能推理在工作区配置 Rerank 模型前保持「环境受限」，不得以页面上能选代替执行验证。
- 自定义提示词尾缀标记依赖模型遵循度，存在随机性，验收不应以单次回答缺失判定链路失败。
- 两个仓库的本轮改动仍未提交（含本文件与收口方案的提交），等待用户指示。
