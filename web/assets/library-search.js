/* Knowledge overview and multi-source evidence search, backed exclusively by core MCP. */
(function () {
  "use strict";
  const A = window.App, E = window.Explorer, Data = window.ExplorerData;
  const h = value => A.escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const names = { document: "文档证据", wiki: "Wiki 知识", graph: "图谱检索证据" };
  const L = { mounted: false, kbId: "", seq: 0, loaded: "" };
  const R = { mounted: false, ids: [], seq: 0, busy: false, lastQuery: "" };
  const valid = (epoch, state, seq) => A.isCurrentIdentityEpoch(epoch) && state.seq === seq;
  const panel = id => document.getElementById("view-" + id);
  const empty = (message, kind = "") => `<div class="explorer-empty ${kind}" role="status">${h(message)}</div>`;

  function navigate(name, kbId, query) {
    if (name === "wiki-graph") { window.KnowledgeViews.graph.openWikiGraph(kbId, ""); return; }
    const view = window.KnowledgeViews[name];
    if (name === "wiki" && view && view.openPage) { view.openPage(kbId, ""); return; }
    if (name === "graph" && view && view.explore) { view.explore(kbId, query || ""); return; }
    if (name === "qa") {
      A.S.qaKbIds = [kbId]; A.S.qaScopeAll = false; A.S.qaMode = "";
      A.advanceQaEpoch(); A.saveScope(); A.renderScopeSummary();
    }
    location.hash = "#/" + name;
    if (window.Views) window.Views.onSelectionChanged();
  }

  function libraryMount(section) {
    L.mounted = true;
    section.innerHTML = `<div class="explorer-toolbar"><label class="field"><span>查看知识库</span><select id="l-kb" class="input select" aria-label="概览知识库"></select></label>
      <button id="l-refresh" class="btn ghost">刷新状态</button><span class="grow"></span><a class="btn" href="#/materials">上传新资料</a></div>
      <div id="l-body" aria-live="polite"></div>`;
    section.querySelector("#l-kb").onchange = event => { L.kbId = event.target.value; L.seq++; loadLibrary(section); };
    section.querySelector("#l-refresh").onclick = () => loadLibrary(section);
  }
  function syncLibrary(section) {
    if (!section || !L.mounted) return;
    const previous = L.kbId;
    L.kbId = E.fillKbSelect(section.querySelector("#l-kb"), L.kbId);
    if (!L.kbId) { L.seq++; L.loaded = ""; section.querySelector("#l-body").innerHTML = empty("连接账号后，在这里查看知识库的内容与能力状态。"); return; }
    if (previous !== L.kbId || L.loaded !== L.kbId) loadLibrary(section);
  }
  async function loadLibrary(section) {
    const body = section.querySelector("#l-body");
    const seq = ++L.seq, epoch = A.captureIdentityEpoch(), kbId = L.kbId;
    L.loaded = kbId;
    if (!kbId) { body.innerHTML = empty("请先选择知识库。"); return; }
    body.innerHTML = empty("正在读取知识库状态…");
    section.querySelector("#l-refresh").disabled = true;
    const response = await E.call("knowledge_base", { action: "get", knowledge_base_id: kbId }, [kbId]);
    if (!valid(epoch, L, seq) || response.stale) return;
    section.querySelector("#l-refresh").disabled = false;
    if (!response.ok) { body.innerHTML = empty(response.error || "知识库状态读取失败", "error"); return; }
    const detail = Data.normalizeDetail(response.result), status = detail.status;
    const wiki = status.wiki || {}, graph = status.graph || {}, flags = status.configured_capabilities || {};
    const number = value => value === null || value === undefined ? "—" : String(value);
    const runtime = (enabled, report) => !enabled ? "未启用" : report.is_active ? "生成中" :
      report.available === "available" ? "可用" : report.available === "unavailable" ? "暂不可用" : "状态待确认";
    const chips = Object.entries({ vector: "语义检索", keyword: "关键词检索", wiki: "Wiki", graph: "知识图谱" })
      .map(([key, label]) => `<span class="badge ${flags[key] ? "ok" : "gray"}">${label} · ${flags[key] ? "已启用" : "未启用"}</span>`).join("");
    body.innerHTML = `<div class="explorer-library-title"><div><h2>${h(status.name || (A.S.kbs.find(k => k.id === kbId) || {}).name || "知识库")}</h2><p class="muted">每个数字和状态均来自当前账号可见的知识库。</p></div><div class="explorer-chips">${chips}</div></div>
      <div class="explorer-stats">${[["文档", detail.documents], ["文本分块", detail.chunks], ["Wiki 页面", flags.wiki ? wiki.total_pages : null], ["处理中资料", status.counts_known === false ? null : status.processing_documents]]
        .map(([label, value]) => `<div class="explorer-stat"><span>${label}</span><strong>${h(number(value))}</strong></div>`).join("")}</div>
      ${status.counts_known === false ? '<p class="explorer-notice">当前服务未提供可靠的文档统计，“—”不代表零。</p>' : ""}
      <div class="explorer-overview-grid"><article class="card explorer-cap-card"><div class="explorer-card-head"><h3>Wiki 知识</h3><span class="badge ${flags.wiki ? "info" : "gray"}">${runtime(flags.wiki, wiki)}</span></div>
        <p>浏览和管理主题页面，查看版本历史、页面链接及原文来源。</p><div class="explorer-facts"><span>待处理 ${h(number(wiki.pending_tasks))}</span><span>链接 ${h(number(wiki.total_links))}</span></div>
        <p class="muted">${h(wiki.available_error || (!flags.wiki ? "该库尚未启用 Wiki，可在创建知识库时配置。" : "页面写入由端点和当前账号权限控制。"))}</p><button data-page="wiki" class="btn ghost">浏览与管理 Wiki</button> <button data-page="wiki-graph" class="btn ghost">查看页面链接图</button></article>
      <article class="card explorer-cap-card"><div class="explorer-card-head"><h3>实体关系图谱</h3><span class="badge ${flags.graph ? "info" : "gray"}">${runtime(flags.graph, graph)}</span></div>
        <p>按实体或问题查询局部关系图，点击关系核对对应的原文证据。</p><div class="explorer-facts"><span>实体类型 ${h((graph.entity_types || []).join("、") || "—")}</span></div>
        <p class="muted">${h(graph.available_error || graph.note || (!flags.graph ? "该库尚未启用图谱抽取。" : "局部查询图不代表全库图谱。"))}</p><button data-page="graph" class="btn ghost">探索图谱</button></article></div>
      <div class="explorer-overview-grid"><article class="card"><div class="explorer-card-head"><h3>解析方式</h3><span class="badge ${detail.docreader ? "ok" : "gray"}">${detail.docreader ? "解析服务在线" : "以引擎状态为准"}</span></div>
      <div class="explorer-table-wrap"><table class="explorer-table"><thead><tr><th>引擎</th><th>可用性</th></tr></thead><tbody>${detail.engines.map(engine => `<tr><td>${h(engine.label || engine.name)}${engine.reason || engine.unavailable_reason ? `<small>${h(engine.reason || engine.unavailable_reason)}</small>` : ""}</td><td><span class="badge ${engine.available ? "ok" : "gray"}">${engine.available ? "可用" : "未配置或不可用"}</span></td></tr>`).join("") || '<tr><td colspan="2">没有返回解析目录。</td></tr>'}</tbody></table></div></article>
      <article class="card"><h3>已发布的问答配置</h3><p class="muted">选择“端点默认”模式时，使用该端点发布的配置。</p><div class="explorer-profiles">${detail.profiles.map(profile => `<div><strong>${h(profile.label || "端点默认")}</strong><p>${h(profile.description || "")}</p></div>`).join("") || '<p class="muted">当前端点没有额外发布配置。</p>'}</div><button data-page="qa" class="btn">在这个知识库提问</button></article></div>`;
    body.querySelectorAll("[data-page]").forEach(button => { button.onclick = () => navigate(button.dataset.page, kbId); });
  }

  function searchMount(section) {
    R.mounted = true;
    section.innerHTML = `<form id="s-form" class="explorer-query"><label class="sr-only" for="s-query">检索问题或关键词</label><input id="s-query" class="input" placeholder="输入问题、实体名称或需要核对的短语" required maxlength="2000"><button id="s-run" class="btn" type="submit">检索证据</button></form>
      <div class="explorer-search-layout"><aside class="card explorer-filters"><h3>检索范围</h3><div id="s-kbs" class="explorer-kb-checks"></div><h3>资料来源</h3><div class="explorer-source-checks">${Object.entries(names).map(([key, label]) => `<label><input type="checkbox" name="s-source" value="${key}" ${key === "document" ? "checked" : ""}> ${label}</label>`).join("")}</div>
      <label class="field"><span>检索模式</span><select id="s-mode" class="input select">${Data.searchModes.map(mode => `<option value="${mode.value}">${mode.label}</option>`).join("")}</select></label>
      <label class="explorer-literal"><input id="s-literal" type="checkbox"> 文档字面匹配</label><p class="muted">字面匹配只查文档；Wiki 和图谱使用各自的检索方式。每次最多选择 10 个知识库。</p></aside>
      <div><div id="s-status" class="explorer-search-status" role="status"></div><div id="s-results" aria-live="polite">${empty("选择范围并输入问题，查看文档、Wiki 与图谱返回的证据。")}</div></div></div>`;
    section.querySelector("#s-form").onsubmit = event => { event.preventDefault(); runSearch(section); };
    section.querySelector("#s-literal").onchange = event => {
      if (event.target.checked) {
        section.querySelectorAll('[name="s-source"]').forEach(box => { box.checked = box.value === "document"; });
        section.querySelector("#s-mode").value = "keyword";
      }
      invalidateSearch(section);
    };
    section.querySelectorAll('[name="s-source"]').forEach(box => { box.onchange = () => {
      if (box.value !== "document" && box.checked) section.querySelector("#s-literal").checked = false;
      invalidateSearch(section);
    }; });
    section.querySelector("#s-mode").onchange = () => invalidateSearch(section);
  }
  function invalidateSearch(section) {
    R.seq++; R.busy = false;
    section.querySelector("#s-run").disabled = false;
    section.querySelector("#s-status").textContent = "范围或检索方式已更改，请重新检索。";
    section.querySelector("#s-results").innerHTML = empty("等待新的检索。");
  }
  function syncSearch(section) {
    if (!section || !R.mounted) return;
    const kbs = A.S.kbs || [], available = new Set(kbs.map(k => k.id));
    const previous = R.ids.join(",");
    R.ids = R.ids.filter(id => available.has(id));
    if (!R.ids.length && kbs.length) R.ids = [kbs[0].id];
    const box = section.querySelector("#s-kbs"); box.replaceChildren();
    if (!kbs.length) box.innerHTML = '<p class="muted">连接后加载知识库。</p>';
    for (const kb of kbs) {
      const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span");
      input.type = "checkbox"; input.value = kb.id; input.checked = R.ids.includes(kb.id); text.textContent = kb.name || kb.id;
      input.onchange = () => { R.ids = Array.from(box.querySelectorAll("input:checked")).map(item => item.value); invalidateSearch(section); };
      label.append(input, text); box.appendChild(label);
    }
    if (previous !== R.ids.join(",")) invalidateSearch(section);
  }
  async function runSearch(section) {
    const query = section.querySelector("#s-query").value.trim();
    const sources = Array.from(section.querySelectorAll('[name="s-source"]:checked')).map(item => item.value);
    if (!query || !R.ids.length || !sources.length) { A.toast("请输入问题，并选择知识库和资料来源。", "err"); return; }
    if (R.ids.length > 10) { A.toast("每次最多检索 10 个知识库，请收窄范围。", "err"); return; }
    const ids = [...R.ids], epoch = A.captureIdentityEpoch(), seq = ++R.seq;
    const args = { query, knowledge_base_ids: ids, sources, mode: section.querySelector("#s-mode").value, limit: 10 };
    if (section.querySelector("#s-literal").checked) args.match = "literal";
    R.busy = true; R.lastQuery = query;
    section.querySelector("#s-run").disabled = true;
    section.querySelector("#s-status").textContent = "正在检索所选来源…";
    section.querySelector("#s-results").innerHTML = empty("正在查找证据…");
    const response = await E.call("search_knowledge", args, ids);
    if (!valid(epoch, R, seq) || response.stale) return;
    R.busy = false; section.querySelector("#s-run").disabled = false;
    if (!response.ok) {
      section.querySelector("#s-status").textContent = "检索失败";
      section.querySelector("#s-results").innerHTML = empty(response.error || "检索未完成", "error"); return;
    }
    const result = Data.normalizeSearch(response.result);
    section.querySelector("#s-status").textContent = result.partial ? "部分来源未完成，请查看各来源的错误；已有证据仍可阅读。" : `“${query}” · ${result.groups.length} 个来源已返回`;
    const list = section.querySelector("#s-results"); list.replaceChildren();
    for (const group of result.groups) {
      const article = document.createElement("article"); article.className = "card explorer-result-group";
      article.innerHTML = `<div class="explorer-card-head"><h3>${h(names[group.source] || group.source)}</h3><span class="badge ${group.error ? "warn" : "info"}">${group.error ? "未完成" : group.items.length + " 条证据"}</span></div>`;
      if (group.error) article.insertAdjacentHTML("beforeend", empty(group.error, "error"));
      else if (!group.items.length) article.insertAdjacentHTML("beforeend", empty("没有找到相关证据。可调整关键词或检查知识库是否处理完成。"));
      for (const item of group.items) {
        const row = document.createElement("div"); row.className = "explorer-hit";
        const title = item.title || item.knowledge_title || item.file_name || item.slug || "检索证据";
        const text = item.content || item.excerpt || item.text || item.summary || "";
        row.innerHTML = `<h4>${h(title)}</h4><p class="explorer-hit-text">${h(String(text).slice(0, 1200))}${String(text).length > 1200 ? "…" : ""}</p>`;
        const actions = document.createElement("div"); actions.className = "explorer-hit-actions";
        const id = item.knowledge_id || item.document_id;
        if (id) {
          const button = document.createElement("button"); button.className = "btn ghost small"; button.textContent = "回读原文";
          button.onclick = () => E.openSource({ ...item, knowledge_id: id, quote: text }, item.knowledge_base_id || ids[0]); actions.appendChild(button);
        }
        if (group.source === "wiki" && item.slug) {
          const button = document.createElement("button"); button.className = "btn ghost small"; button.textContent = "阅读 Wiki 页面";
          button.onclick = () => window.KnowledgeViews.wiki.openPage(item.knowledge_base_id || ids[0], item.slug); actions.appendChild(button);
        }
        row.appendChild(actions); article.appendChild(row);
      }
      if (group.source === "graph" || group.source === "wiki") {
        for (const kbId of Data.sourceLibraries(group, ids, A.S.kbs || [])) {
          const button = document.createElement("button"); button.className = "btn ghost small";
          const kb = (A.S.kbs || []).find(item => item.id === kbId);
          button.textContent = (group.source === "graph" ? "在图谱中探索" : "浏览 Wiki 目录") + ` · ${kb?.name || kbId}`;
          button.onclick = () => navigate(group.source, kbId, query); article.appendChild(button);
        }
      }
      list.appendChild(article);
    }
  }

  window.KnowledgeViews.library = {
    show(section) { if (!L.mounted) libraryMount(section); syncLibrary(section); },
    reset() { Object.assign(L, { mounted: false, kbId: "", loaded: "", seq: L.seq + 1 }); },
    selectionChanged() { syncLibrary(panel("library")); },
  };
  window.KnowledgeViews.search = {
    show(section) { if (!R.mounted) searchMount(section); syncSearch(section); },
    reset() { Object.assign(R, { mounted: false, ids: [], busy: false, lastQuery: "", seq: R.seq + 1 }); },
    selectionChanged() { syncSearch(panel("search")); },
  };
})();
