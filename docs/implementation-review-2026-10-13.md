# WeKnora 与纯 Agent 实施审查

审查日期：2026-10-13。WeKnora HEAD：130d7d49c；WeKnora-Agent HEAD：1d68ce5。

结论：**Agent 架构符合预期；WeKnora 的职责归属正确，但核心功能和评估尚不能按全部达标验收。** 本次只审查、运行测试及只读服务查询，没有修改业务代码、停止服务或重新执行付费模型问答。

## 1. 符合预期的部分

- Agent 生产代码只有 main.py、agent.py。标准 ChatOpenAI、MultiServerMCPClient.get_tools、create_agent、ainvoke；没有自研 MCP/runtime、Web API、登录会话、上传业务、数据库或证据 Registry。
- 13 项只读工具过滤和缺失告警，包含 RAG、Wiki、实体图谱；模型和 MCP 身份配置在外部，授权由服务处理。
- 部署和离线评估在 WeKnora/examples/mcp-validation，不进入 Agent 的运行代码。
- WeKnora 已实现上传暂存／导入、用户身份、范围交集、结构化错误、检索截断信号、Wiki 和图谱工具；此前“所有边借用全局证据”的实现已经重写，但仍有下述真实调用问题。
- manifest 十篇文档都已有真实 ID；已有十二题实际模型问答记录。没有足够原始工具证据证明这些记录的召回／准确性指标。

## 2. 本次实际验证

| 验证 | 结果 |
| --- | --- |
| Agent pytest tests | 13 passed in 38.94s |
| Agent pip check | No broken requirements found |
| Agent CLI --help | 退出 0 |
| WeKnora 离线脚本 pytest | 10 passed in 1.23s |
| 迁移后 Compose config --quiet | 退出 0 |
| 当前工作区只读挂载到 Linux check 镜像 | mcpserver、middleware、router、types、Neo4j repository 测试通过；mcpscope 无测试文件 |
| 真实 MCP tools/list | 16 个工具可发现 |
| 真实 KB 状态与文档列表对照 | 状态 reports documents=0/counts_known=true；同 KB list_documents.total=10，已复现错误 |
| 当前 SQLite 的 PRAGMA table_info(wiki_pages) | 没有 source_refs_v2 列，已确认 schema 与模型不一致 |
| 评估反例 | 无工具调用仍被记为找到 doc01/doc02；明确编造答案仍被评为无答案诚实 1/1 |

Go 命令：

```powershell
docker run --rm --entrypoint go --mount 'type=bind,source=E:\GoLandCode\WeKnora,target=/review-src,readonly' --workdir /review-src weknora-agent-check:local test -tags sqlite_fts5 -count=1 ./internal/mcpscope ./internal/mcpserver ./internal/middleware ./internal/router ./internal/types ./internal/application/repository/retriever/neo4j
```

这是指定包验证，不是全量 Go 测试，也没有覆盖 Wiki repository 的创建测试。没有为了验证权限绕过而向真实服务写入文件，没有创建 Wiki 页面或写 Neo4j 数据。写路径结论来自可定位的代码链路；状态、schema 和评估反例另有实测证据。

## 3. 应优先修复的 P1 问题

### R1. 用户模式上传绕过用户角色／KB 创建者门禁

位置：WeKnora/internal/mcpserver/upload_transport.go:254；scope.go:79；internal/application/access/knowledgebase.go:117；REST 对照 internal/router/routes_knowledge.go:73。

有效 Viewer JWT、支持 import 的端点、同空间非本人创建的 KB：MCP 经 scopedKBContext(Editor) 调 ResolveKB，同空间直接取得 Admin 资源权限，再生成 Editor 写 grant。RequireKBWrite 只检查 grant 和 ingest capability，并不再检查用户角色／创建者。REST file 路由另外有 OwnedKBOrAdmin，MCP 没有对应检查。

影响：端点允许导入会放大只读成员权限，违背“用户权限与端点权限交集”。不是跨用户读取泄漏；问题是写入口丢失了原有角色／归属门禁。

修复：用户模式写入复用实际角色／创建者决策后才能生成写 grant；机器端点另按其 capability 处理。用户模式也有 APIKeyScope，不能以该字段存在就误判为可绕过角色检查的 machine。新增 Viewer、非创建者 Contributor、创建者和管理员对上传／导入的矩阵测试。

### R2. Wiki 新字段没有数据库迁移

位置：internal/types/wiki_page.go:247；internal/application/repository/wiki_page.go:95。

SourceRefsV2 标记 gorm:"type:json"，repository Create(page) 会包含这个字段；SQLite／PostgreSQL migrations 均没有 source_refs_v2。本次从运行数据库只读确认该列缺失。

影响：开启 Wiki 后的页面创建／生成存在缺列回归，当前未启用 Wiki 的演示 KB 没有暴露该问题。

修复：如果仅为 MCP 返回时补充的字段，用 gorm:"-" 或响应 DTO；确实要持久化，则补两种数据库迁移、正确 JSON 序列化和创建／更新回归测试。必须运行现有 Wiki repository 测试及真实页面生成。

### R3. 图谱来源补充在实际调用中被跳过

位置：internal/mcpserver/tools_graph.go:160、182；internal/agent/tools/query_knowledge_graph.go:854。

业务工具原生 Go 返回 edges/results 为 []map[string]interface{}，MCP helper 只接受 []interface{}。Execute 后没有 JSON 往返，类型断言失败直接返回，真实查询的 edge 没有 source_refs_v2。即便只修 edges，results 索引仍空，quote 和 KB 仍不能取得。

修复：同时接受原生／JSON 解码形状或使用统一类型；测试直接消费业务工具 Execute 的结果。当前 provenance 测试手造 []interface{}，不能覆盖实际路径。

### R4. Wiki 读页同样跳过来源补充

位置：internal/mcpserver/tools_wiki.go:220；internal/agent/tools/wiki_tools.go:511。

found_kbs 的实际类型是 map[string][]string，MCP 只接受 map[string]interface{}，成功读页也会提前返回，约定的 source_refs_v2 不被生成。

修复：接受实际类型并增加真实业务返回到 MCP handler 的组合测试；对老页面来源仍须分别标注 unknown／unverified。

### R5. 旧图谱同名关系实例被丢失

位置：internal/agent/tools/query_knowledge_graph.go:387。

聚合键为 KnowledgeID + 显示名称 + 类型。旧 Neo4j 边没有新 kg 属性，KnowledgeID 为空；不同文档的同名关系虽然有不同真实 relation/endpoint ID，仍被合并成一条。

修复：按 KB 与真实 relation ID 去重，缺 ID 才使用真实文档／端点身份回退。新增旧数据、多 KB、同名关系的业务聚合测试；只测试 decoder 返回两条不足以证明聚合不丢失。

### R6. 评估闭环不符合定义，现有百分比不能作为验收证据

位置：examples/mcp-validation/scripts/run_eval.py:135、187、192；score_eval.py:121、135、159。

确定的问题：

1. found_documents 从最终答案里的 docNN／UUID 提取，甚至把非引用的 docNN 合并回来。反例：只有“检索范围 doc01/doc02，未调用任何工具”的答案，也被记为找到这两篇。
2. evidence recall 从最终答案前 18／20 字符匹配推断，不是检查工具实际返回并读到的原文证据。
3. 无答案题没有 required_evidence，hit_evidence 永远为空，所以任何编造答案都算“诚实”。已用明确虚构预算答案复现 1/1。
4. ask_agent 收集 raw_events 后，build_record 只保存数量和工具名；十二条 runs.jsonl 均无原始 AIMessage/ToolMessage、content、artifact、status。交付报告所称原始轨迹没有保存。
5. 没有单次检索基线，也没有 --strategy both 实现；记录没有 strategy 字段。
6. 人工复核有十二条 reviewed=false。score_eval 只读取条目数，不计算已定义的事实／完整／引用指标；用户填完数字再跑也不会得到承诺的分子分母报告。
7. 评估器重新构建 Agent，模型 timeout=120、整体180秒且 discovery在timeout外，生产入口为模型60／整体120秒。实测不能直接证明默认 CLI 的运行预算表现。

修复：保存原始工具消息和显式成功／失败状态；从真实工具内容统计发现文档与已读取证据；最终引用另算，不与检索召回混同。无答案通过逐事实复核／明确标注判断，异常不算诚实。补单次检索基线、人工指标汇总、缺记录／未知／失败的处理；复用生产 Agent 构造与调用设置。

当前报告的“文档 recall=1.0、找齐率10/10、无答案2/2”尚不可信；“必需证据0.8”仅是答案子串指标，也不是约定的检索证据 recall。人工准确性仍未评估，不能宣称任务8完整达标。

## 4. 其他必须跟进的 P2 问题

| 编号 | 位置 | 问题与最小修复 |
| --- | --- | --- |
| R7 | internal/mcpserver/tools_status.go:242 | 未加载计数的 Go 零值被当 counts_known=true。真实查询已复现 0 对 10。获取实际文档／chunk／处理中计数，失败标 unknown；不能用 >=0 判断“已查询”。 |
| R8 | internal/mcpserver/upload_staging.go:230 | 相同 key／KB／文件名即回放，不读取新字节／hash；HTTP 没有 DeclaredSize，连不同长度也会回放旧文件。对重放仍做有界读取、大小与 SHA256 校验，并覆盖 abc→xyz。 |
| R9 | internal/mcpserver/upload_staging.go:452；upload_repository.go:275 | Sweep 只变更／删除 DB 行，不删除 payload，且没有生产调度入口。加入清理调度，先可重试地删除过期文件再删除回执，尊重活跃租约；检查磁盘而非只检查行数。 |
| R10 | internal/mcpserver/tools_import.go:241 | Complete 落回执失败仅 Warn，随后仍 accepted=true。传播持久化／租约错误，携带已经创建的知识 ID，建立可恢复持久化，不能无回执报整个流程成功。 |
| R11 | internal/router/router.go:125 | CORS 未放行 KB scope 与 Idempotency-Key，跨源浏览器上传／MCP 的预检会拒绝。补请求头及 OPTIONS 测试。 |
| R12 | internal/application/repository/retriever/neo4j/repository.go:117 | chunks 只传给 apoc.merge.relationship 的 onCreateProps；同关系第二个 chunk 不合并。匹配已有边后 union chunks，测试两次 AddGraph→读取。 |
| R13 | Neo4j SearchNode 上限到 GraphData／业务输出 | backend seed/row cap 只日志告警，不透传截断；后续计数可能把截断集合当完整。传递 backend cap 与 coverage 信号。 |
| R14 | examples/mcp-validation/requirements-dev.txt:4 | -r ../../WeKnora-Agent/requirements.txt 解析到 WeKnora/WeKnora-Agent 而非相邻仓库，路径不存在。应拆开安装或明确相邻路径／环境变量，避免硬编码错路径。 |

R12 的参数语义已核对 [APOC 官方文档](https://neo4j.com/docs/apoc/current/overview/apoc.merge/apoc.merge.relationship/)：onCreateProps 只在创建时应用，未提供的 onMatchProps 默认为空。

Agent 测试还有非阻断缺口：HTTP fixture 不检查身份请求头，不能证明缺／错 JWT 被拒；测试服务器用 daemon thread 不释放；超时／递归测试捕获任意 Exception，不能区分目标错误与意外连接失败。保持生产结构不变，只补准确的 SDK／服务测试。

## 5. 真实链路尚缺的验收

- 当前演示 KB 没有完成 Wiki 和实体图谱正向生成／写读验收；delivery.md 明确承认这一点。
- smoke 中图谱调用为未配置错误，报告含 failed_required_call；这证明错误路径，不能证明真正查询图谱成功。
- WeKnora UI 使用 release 镜像，现有组件存在不等于新 MCP 来源结构和异常展示已验收。
- 原始模型工具轨迹没有持久化，十二题事实准确、完整和引用支持未人工核验；补评分实现之后需要新的可追溯记录。

## 6. 建议执行顺序

1. 修复 R1 用户模式写权限、R2 Wiki 数据模型／schema 回归。
2. 修复 R3/R4 原生返回类型，补业务工具到 MCP 的组合测试。
3. 修复 R5/R12/R13 真实关系来源、去重与截断；修 R7 真实状态计数。
4. 修复 R8～R11 上传幂等、持久回执、清理和浏览器头契约。
5. 配置隔离 Wiki／graph 测试 KB，真实生成／读取原文及关系；不能用模拟结果或配置关闭错误替代。
6. 修复 R6 评估器和 R14 安装路径，保留原始轨迹，跑基线对比，完成人工复核；重写交付报告的通过／未通过状态。

无需恢复 Agent 的 frontend/backend、登录、数据库或自研运行时。后续主要工作仍在 WeKnora 服务和其离线验证目录。
