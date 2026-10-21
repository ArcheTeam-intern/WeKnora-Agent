# 五工具 MCP 主产品演示工作台

用户已明确要求直接修改当前项目，不再停在方案或审批环节。实施在当前 WeKnora-Agent 工作区完成；保留 WeKnora 中用户已有文档修改，不变更业务数据或认证职责。

## 目标与界面

现有资料解析、文档目录/原文阅读、问答和诊断保留。新增四个与五工具子能力对应的产品界面：

- 知识库概览：选择可见库，读取 knowledge_base.get，显示文档/分块/Wiki/graph状态、解析引擎和发布的问答配置。
- 统一检索：明确知识库范围、document/wiki/graph来源，选择混合/语义/关键词或字面匹配；分来源展示结果、partial失败与来源证据。
- Wiki知识：独立库选择、分类目录、搜索、页面阅读、来源核对。现有core只开放读能力，不呈现人工编辑/删除。
- 图谱探索：独立库选择与实体查询，SVG仅绘制实体和关系，关系/节点详情显示各自来源；检索命中文本放到画布外默认折叠的「相关资料」，可阅读和回读原文，不暗示支持某条关系。标明局部查询图谱，不伪装成全库拓扑。

所有业务仍经工作台现有/api/tool转发到/mcp/core/:id，沿用五工具，不连接WeKnora业务REST、数据库、Neo4j或Redis。未授权/未配置/尚未生成/无结果/请求失败分别显示；不给错误结果套空列表成功状态。

## 模块契约

`web/assets/explorer.js` 提供 `window.Explorer`：

```js
Explorer.call(name, args, kbIds = []) // Promise<{ok,result,error,stale}>
Explorer.fillKbSelect(select, currentId, capability = '') // return selected id
Explorer.capability(kb, name) // boolean
Explorer.renderSources(container, refs, kbId) // safe DOM; source verification actions
Explorer.openSource(ref, kbId) // read_document through MCP into modal
```

页面注册到 `window.KnowledgeViews`：`library`、`search`、`wiki`、`graph`，各实现 `show(section)`、`reset()`、`selectionChanged()`。现有Views负责调用，不在大文件里继续堆全部页面。身份切换必须清空数据并使旧请求失效，每页独立库选择和请求序号，旧库/旧查询的迟到响应不覆盖新状态。

Wiki与graph页分别拥有各自JS/CSS/测试，避免并行写同文件。数据通过textContent或转义/既有安全Markdown渲染，图谱使用真实节点/边，不制造关系或来源。

## 验收

先写协议/解析/状态交错的失败用例，再实现；Node测试验证数据处理和DOM状态，既有Python/Node回归验证原流程。浏览器真实连接现有MCP：目录五项、概览、Wiki目录→正文→引用、图谱查询→节点/关系→来源、统一检索、旧页面回归。真实只读验收优先，不为了截图改用户库配置或删除资料。
