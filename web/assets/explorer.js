/* Product-facing views share the same five-tool MCP boundary as the workbench. */
(function (root) {
  "use strict";
  const searchModes = [{ value: "hybrid", label: "混合检索" }, { value: "semantic", label: "语义检索" }, { value: "keyword", label: "关键词检索" }];
  function capability(kb, name) {
    if (kb && typeof (kb.capability_flags || {})[name] === "boolean") return kb.capability_flags[name];
    const value = (kb || {}).capabilities;
    return Array.isArray(value) ? value.includes(name) : !!(value || {})[name];
  }
  function normalizeDetail(payload) {
    const library = (payload || {}).knowledge_base || payload || {};
    const wrapper = library.status || {};
    const status = wrapper.status || wrapper;
    const parser = library.parser_engines || {};
    return { library, status, engines: parser.engines || [], profiles: library.qa_profiles || [],
      docreader: parser.docreader_connected,
      documents: status.counts_known === false ? null : (status.documents ?? null),
      chunks: status.counts_known === false ? null : (status.chunks ?? null) };
  }
  function decodeText(text) {
    return String(text || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&");
  }
  function wikiRows(content) {
    const rows = [];
    for (const match of String(content || "").matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/gi)) {
      const text = match[1];
      const tag = name => decodeText((text.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i")) || [])[1] || "");
      const link = tag("link").match(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/);
      rows.push({ slug: tag("slug") || (link ? link[1] : ""),
        title: tag("title") || (link ? link[2] || link[1] : "Wiki 页面"),
        knowledge_base_id: tag("knowledge_base_id"), content: tag("match_snippet") || tag("summary") || tag("excerpt") || tag("content") });
    }
    return rows;
  }
  function normalizeSearch(payload) {
    payload = payload || {};
    const sources = payload.sources || Object.keys(payload.results || {});
    const groups = sources.map(source => {
      const original = (payload.results || {})[source] || {};
      const block = original.data && typeof original.data === "object" ? { ...original, ...original.data } : original;
      let items = [block.results, block.pages, block.matches, block.hits].find(Array.isArray) || [];
      if (source === "wiki" && !items.length) items = wikiRows(block.content || block.output || block.text);
      const failure = (payload.failures || []).find(f => f.source === source);
      const xmlErrors = String(block.content || block.output || block.text || "").match(/<errors[^>]*>([\s\S]*?)<\/errors>/i);
      const nestedErrors = block.errors ? (Array.isArray(block.errors) ? block.errors : [block.errors]) : [];
      const errors = nestedErrors.map(error => typeof error === "string" ? error : JSON.stringify(error));
      if (xmlErrors) errors.push(decodeText(xmlErrors[1]).trim());
      if (failure) errors.push(String(failure.error || "该来源检索失败"));
      if (!errors.length && (payload.failed_sources || []).includes(source)) errors.push("该来源检索失败");
      return { source, items, block,
        error: errors.filter(Boolean).join("；") };
    });
    return { groups, partial: !!payload.partial || groups.some(group => !!group.error), query: payload.query || "" };
  }
  function sourceLibraries(group, selectedIds, kbs) {
    const hits = [...new Set((group.items || []).map(item => item.knowledge_base_id).filter(id => selectedIds.includes(id)))];
    return hits.length ? hits : selectedIds.filter(id => capability(kbs.find(kb => kb.id === id), group.source));
  }
  function provenanceLabel(ref) {
    const status = (ref || {}).provenance_status || (ref || {}).provenance;
    if (status === "verified") return "已核对来源";
    if (status === "unverified_source") return "来源待核对";
    return "来源未知";
  }
  function createExplorer(app, doc) {
    const current = epoch => !app.isCurrentIdentityEpoch || app.isCurrentIdentityEpoch(epoch);
    async function call(name, args, kbIds = []) {
      const epoch = app.captureIdentityEpoch ? app.captureIdentityEpoch() : 0;
      try {
        const response = await app.api("/api/tool", { method: "POST", json: { name, arguments: args },
          headers: app.mcpHeaders({ kbIds }), brief: `${name}${args.action ? "." + args.action : ""}` });
        if (response.stale || !current(epoch)) return { ok: false, stale: true };
        const data = response.data || {};
        return { ok: !!(response.ok && data.ok), result: data.result,
          error: data.error || response.error || (!response.ok ? `请求失败（${response.status || "网络不可用"}）` : ""),
          errorCode: data.error_code || "" };
      } catch (_) {
        return current(epoch) ? { ok: false, error: "请求未完成，请检查连接后重试" } : { ok: false, stale: true };
      }
    }
    function fillKbSelect(select, currentId, preferred = "") {
      const kbs = app.S.kbs || [];
      select.replaceChildren();
      const placeholder = doc.createElement("option");
      placeholder.value = ""; placeholder.textContent = kbs.length ? "选择知识库" : "连接后加载知识库";
      select.appendChild(placeholder);
      for (const kb of kbs) {
        const option = doc.createElement("option"); option.value = kb.id; option.textContent = kb.name || kb.id;
        select.appendChild(option);
      }
      const valid = kbs.some(k => k.id === currentId);
      const first = (preferred && kbs.find(k => capability(k, preferred))) || kbs[0];
      select.value = valid ? currentId : (first ? first.id : "");
      return select.value;
    }
    async function openSource(ref, fallbackKb) {
      const id = ref.knowledge_id || ref.document_id;
      if (!id) { app.toast("该条来源未提供可回读的文档标识", "err"); return; }
      const epoch = app.captureIdentityEpoch();
      const kbId = ref.knowledge_base_id || fallbackKb;
      let pane;
      app.openModal(box => {
        const title = doc.createElement("h3"); title.textContent = ref.title || ref.knowledge_title || "来源原文";
        pane = doc.createElement("div"); pane.className = "explorer-source-reader"; pane.textContent = "正在回读原文…";
        const close = doc.createElement("button"); close.className = "btn ghost small"; close.textContent = "关闭"; close.onclick = app.closeModal;
        box.append(title, pane, close);
      });
      const args = { action: "read", source_type: "document", knowledge_id: id, limit: 20 };
      const result = await call("read_document", args, kbId ? [kbId] : []);
      if (result.stale || !current(epoch) || !pane.isConnected) return;
      pane.replaceChildren();
      if (!result.ok) { pane.textContent = result.error || "原文回读失败"; return; }
      const payload = result.result || {}, document = payload.document || payload;
      const chunks = document.chunks || document.results || [];
      const wanted = new Set(ref.chunk_ids || (ref.chunk_id ? [ref.chunk_id] : []));
      const found = chunks.filter(c => wanted.has(c.chunk_id || c.id));
      const content = doc.createElement("div"); content.className = "markdown";
      const visible = found.length ? found : chunks;
      content.innerHTML = app.renderMarkdown(visible.map(c => c.content || c.text || "").join("\n\n") || document.content || document.text || "未返回可读原文");
      if (wanted.size && found.length < wanted.size) {
        const note = doc.createElement("p"); note.className = "explorer-notice";
        note.textContent = "当前回读页未包含全部引用分块，下面展示文档当前页；该结果不能替代指定分块的完整核验。";
        pane.appendChild(note);
      }
      pane.appendChild(content);
    }
    function renderSources(container, refs, fallbackKb) {
      container.replaceChildren();
      if (!Array.isArray(refs) || !refs.length) {
        const empty = doc.createElement("p"); empty.className = "muted"; empty.textContent = "没有提供可核对的来源信息。"; container.appendChild(empty); return;
      }
      for (const ref of refs) {
        const item = doc.createElement("div"); item.className = "explorer-source";
        const head = doc.createElement("div"); head.className = "explorer-source-head";
        const name = doc.createElement("strong"); name.textContent = ref.title || ref.knowledge_title || ref.knowledge_id || ref.document_id || "来源";
        const badge = doc.createElement("span"); badge.className = "badge " + (provenanceLabel(ref) === "已核对来源" ? "ok" : "gray"); badge.textContent = provenanceLabel(ref);
        head.append(name, badge); item.appendChild(head);
        const quote = doc.createElement("p"); quote.textContent = ref.quote || ref.excerpt || "该来源未提供原文摘录。"; item.appendChild(quote);
        if (ref.knowledge_id || ref.document_id) {
          const button = doc.createElement("button"); button.className = "btn ghost small"; button.textContent = "核对文档原文";
          button.onclick = () => openSource(ref, fallbackKb); item.appendChild(button);
        }
        container.appendChild(item);
      }
    }
    return { call, fillKbSelect, capability, renderSources, openSource };
  }
  const data = { createExplorer, capability, normalizeDetail, normalizeSearch, provenanceLabel, wikiRows, searchModes, sourceLibraries };
  if (typeof module !== "undefined" && module.exports) module.exports = data;
  if (!root || !root.App || !root.document) return;
  root.Explorer = createExplorer(root.App, root.document);
  root.ExplorerData = data;
  root.KnowledgeViews = root.KnowledgeViews || {};
})(typeof window === "undefined" ? globalThis : window);
