# 五工具能力界面实施计划

> **For agentic workers:** 按当前任务直接实施；Wiki、Graph以独立文件并行，根代理集成与验收。

**Goal:** 让主产品演示工作台展示五工具已封装的知识库、检索、Wiki与图谱能力。

**Architecture:** 复用现有Starlette MCP薄转发与原生JS界面。新增共享Explorer薄层和四个插件页面；不新增后端业务实现或MCP工具。

**Tech Stack:** 现有Python/Starlette、vanilla JS、SVG、Node测试、pytest、浏览器验收。

### Task 1：基线与共享接口

- [x] 运行现有Python/Node回归并记录基线。
- [x] 新建tests/test_explorer.js，先验证Explorer.call只调用/api/tool、partial保持、失效响应丢弃及能力标记读取；观察失败。
- [x] 新建web/assets/explorer.js，按设计契约实现；通过Node测试。

### Task 2：Wiki页面

- [x] tests/test_wiki_view.js先覆盖分组目录/搜索XML/正文/过期响应。
- [x] 新建web/assets/wiki-view.js、wiki.css，实现独立选库、目录、搜索、正文、来源；无写按钮。

### Task 3：图谱页面

- [x] tests/test_graph_view.js先覆盖真实local_graph/graph_data解析、边来源和空/partial错误。
- [x] 新建web/assets/graph-view.js、graph.css，实现SVG局部图、缩放/选择、关系列表与证据核对。

### Task 4：概览、统一检索与路由

- [x] 概览与检索以Explorer模块实现，测试各种来源结果及partial状态。
- [x] index.html增加四导航/section/脚本；app.js增加路由标题；views.js仅增加插件生命周期分派。
- [x] 更新缓存版本和README能力映射。

### Task 5：验收

- [x] Node新旧测试和pytest离线回归，修复实际回归。
- [x] 浏览器在真实MCP验证新页面及原页面，检查身份/库切换失效响应、空态和错误态。
- [x] 保存截图与验收记录；不写入日志中的凭据，不覆盖已有用户文档或配置。

完成记录：见 `docs/2026-10-20-core-workbench-acceptance.md`。Node 64/64，Python 69/69。新界面真实读取与问答验收通过；未重复新建/上传/删除写入验收。
