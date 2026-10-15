/* MCP 验证控制台 — 三视图：资料与解析验证 / 问答 / MCP 工具台 */
"use strict";

(function () {
  const { S, api, sse, toast, confirmDialog, renderMarkdown, escapeHtml, mcpHeaders,
          captureIdentityEpoch, isCurrentIdentityEpoch, toolCN, fieldCN, statusCN } = window.App;

  /* ===================== 视图一：资料与解析验证 ===================== */
  const M = {
    file: null, channel: "tool", receipt: null, doc: null,
    steps: [], summary: null, mounted: false, idemAuto: true,
  };

  function uuid4() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // isIdempotencyConflict 识别服务端的「上传标识已用于别的文件/知识库」拒绝，
  // 两条上传通道的错误形状不同（工具通道给 error_code，文件流通道给上游文本）。
  function isIdempotencyConflict(d, r) {
    const code = String((d && d.error_code) || "").toUpperCase();
    const text = JSON.stringify([(d && (d.error || d.detail)) || "", r.error || ""]);
    return code.includes("IDEMPOTENCY") || /Idempotency-Key was already used/i.test(text);
  }

  // uploadErrorText 把两条通道的错误整理成一句人能读的话。
  function uploadErrorText(d, r) {
    const err = d && (d.error || d.detail);
    if (err && typeof err === "object") return err.message || JSON.stringify(err);
    if (typeof err === "string" && err) return err;
    return r.error || String(r.status || "未知错误");
  }

function materialsMount(section) {
    section.innerHTML = `
      <div class="card">
        <h3><span class="step-no">1</span>上传你的资料</h3>
        <div class="sub">文件上传到「目标知识库」——本次上传、导入与状态查询只作用于它。上传通道只决定字节如何送达 WeKnora，解析方式在下一步单独选择。</div>
        <div class="row">
          <label class="field grow"><span>目标知识库（本次上传目标）</span>
            <select id="m-kb" class="input"></select></label>
          <button id="m-kb-new" class="btn ghost small" title="经 MCP create_knowledge_base 新建">＋ 新建知识库</button>
          <label class="field"><span>上传通道</span>
            <div class="seg" id="m-channel">
              <button data-ch="tool" class="on">标准 MCP 工具</button>
              <button data-ch="multipart">文件流（兼容）</button>
            </div></label>
        </div>
        <div class="row">
          <div id="m-drop" class="dropzone grow">
            <div class="big">⬆</div>
            <div>点击或拖拽文件到此处</div>
            <div style="font-size:12px">允许：txt / md / markdown / docx / pdf，≤ 50 MB</div>
            <div class="name hidden" id="m-file-name"></div>
          </div>
          <input type="file" id="m-file" class="hidden" accept=".txt,.md,.markdown,.docx,.pdf">
        </div>
        <div class="row">
          <button id="m-upload" class="btn">上传</button>
          <span id="m-upload-status" class="status-line"></span>
        </div>
        <div id="m-receipt"></div>
        <details class="token-help"><summary>高级：上传请求标识（不理解就别改）</summary>
          <div class="sub" style="margin-top:6px">同一份文件用同一个标识重传 = 幂等重放，不会重复入库；换文件或换知识库时页面会自动换新标识。
          只有在脚本里对接服务端时才需要手填。</div>
          <div class="row" style="margin-top:8px">
            <input id="m-idem" class="input mono grow" autocomplete="off">
            <button id="m-idem-gen" class="btn ghost small">生成新的</button>
          </div>
        </details>
      </div>

      <div class="card">
        <h3><span class="step-no">2</span>解析方式</h3>
        <div class="sub">选项来自本部署真实的解析引擎目录（MCP <span class="mono">list_parser_engines</span>）。默认沿用知识库配置；
        若与既有文档内容相同被去重，会复用旧解析结果，本次选项不会重新应用。</div>
        <div class="row">
          <label class="field grow"><span>解析引擎</span><select id="m-engine" class="input"></select></label>
        </div>
        <div class="row"><span id="m-engine-note" class="kv"></span></div>
      </div>

      <div class="card">
        <h3><span class="step-no">3</span>导入并解析</h3>
        <div class="sub">由 WeKnora 完成解析与索引。下面会实时显示解析/索引进度、请求与实际使用的引擎，解析完成后给出分块数与原文预览。</div>
        <div class="row">
          <button id="m-import" class="btn" disabled>导入</button>
          <span class="kv">document：<b id="m-doc" class="mono">–</b></span>
          <span class="grow"></span>
          <button id="m-recent" class="btn ghost small">查看知识库最近导入</button>
        </div>
        <div class="row"><span id="m-import-status" class="status-line"></span></div>
        <div id="m-doc-status"></div>
        <div id="m-recent-list"></div>
      </div>
    `;

    // --- 通道切换 ---
    section.querySelectorAll("#m-channel button").forEach(btn => {
      btn.onclick = () => {
        M.channel = btn.dataset.ch;
        section.querySelectorAll("#m-channel button").forEach(b => b.classList.toggle("on", b === btn));
      };
    });

    // --- 目标知识库（单选框，与顶栏只读摘要联动）---
    section.querySelector("#m-kb").onchange = e => {
      S.uploadTargetKbId = e.target.value;
      saveScope();
      renderScopeSummary();
      // 标识按「文件 + 目标库」区分：换库后沿用旧标识会被服务端判为冲突。
      if (M.idemAuto) newIdem(section);
    };

    // --- 文件选择 / 拖拽 ---
    const drop = section.querySelector("#m-drop");
    const fileInput = section.querySelector("#m-file");
    const setName = f => {
      const prevName = M.file && M.file.name;
      M.file = f || null;
      const nameEl = section.querySelector("#m-file-name");
      if (f) { nameEl.textContent = `${f.name} · ${(f.size / 1024).toFixed(1)} KB`; nameEl.classList.remove("hidden"); }
      else { nameEl.classList.add("hidden"); }
      // 换文件必须换标识：同一标识配不同字节会被服务端拒绝（幂等契约）。
      if (f && f.name !== prevName && M.idemAuto) newIdem(section);
    };
    drop.onclick = () => fileInput.click();
    fileInput.onchange = () => setName(fileInput.files[0]);
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("dragover"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", e => {
      e.preventDefault(); drop.classList.remove("dragover");
      if (e.dataTransfer.files.length) setName(e.dataTransfer.files[0]);
    });
    // newIdem 生成新标识；用户一旦手改过输入框，就不再自动覆盖。
    function newIdem(sec) {
      const input = sec.querySelector("#m-idem");
      if (input) input.value = uuid4();
      M.idemAuto = true;
    }
    section.querySelector("#m-idem").addEventListener("input", () => { M.idemAuto = false; });
    newIdem(section);
    section.querySelector("#m-idem-gen").onclick = () => newIdem(section);

    // --- 解析引擎选择 ---
    section.querySelector("#m-engine").onchange = e => {
      M.engine = e.target.value;
      renderEngineNote(section);
    };
    renderEngineNote(section);

    // --- 上传 ---
    section.querySelector("#m-upload").onclick = async () => {
      const epoch = captureIdentityEpoch();
      const st = section.querySelector("#m-upload-status");
      const kb = section.querySelector("#m-kb").value;
      if (!window.App.activeProfile()) { toast("请先配置有效 Token", "err"); return; }
      if (!kb) { st.textContent = "请选择目标知识库"; st.classList.add("err"); return; }
      if (!M.file) { st.textContent = "请选择文件"; st.classList.add("err"); return; }
      st.classList.remove("err");
      const channelCN = M.channel === "tool" ? "标准 MCP 工具" : "文件流";
      // 最多两次：上传标识冲突时自动换一个新的标识重试一次（同一标识配不同
      // 字节/知识库会被服务端按幂等契约拒绝，换文件本就不该沿用旧标识）。
      for (let attempt = 1; attempt <= 2; attempt++) {
        const idem = section.querySelector("#m-idem").value.trim();
        st.textContent = `上传中（${channelCN}）…`;
        const fd = new FormData();
        // 字段顺序即契约：knowledge_base_id 必须排在 file 之前。
        fd.append("knowledge_base_id", kb);
        fd.append("file", M.file, M.file.name);
        const path = `/api/upload?channel=${encodeURIComponent(M.channel)}`;
        const headers = Object.assign(materialsHeaders(), idem ? { "Idempotency-Key": idem } : {});
        const r = await api(path, {
          method: "POST", body: fd, headers,
          brief: `上传 ${M.file.name}`,
        });
        // 旧身份的上传回执不得写进新身份的面板。
        if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
        const d = r.data || {};
        // 两条通道的回执形状：multipart={success,data:{...}}；tool={ok,result:{...}}
        const receipt = d.data || d.result || null;
        if (r.ok && receipt && (receipt.upload_id || (receipt.receipt && receipt.receipt.upload_id))) {
          const rr = receipt.receipt || receipt;
          M.receipt = Object.assign({ channel: M.channel, kb }, rr);
          st.textContent = "上传成功";
          renderReceipt(section);
          saveLastImport();
          section.querySelector("#m-import").disabled = false;
          section.querySelector("#m-import-status").textContent = "";
          return;
        }
        if (attempt === 1 && M.idemAuto && isIdempotencyConflict(d, r)) {
          newIdem(section);
          st.textContent = "这个上传标识已用于另一份文件，已自动换新标识并重试…";
          continue;
        }
        st.textContent = "上传失败：" + uploadErrorText(d, r);
        st.classList.add("err");
        return;
      }
    };

    // --- 导入（带上解析方式）---
    section.querySelector("#m-import").onclick = async () => {
      const epoch = captureIdentityEpoch();
      const st = section.querySelector("#m-import-status");
      if (!M.receipt) { st.textContent = "请先上传"; st.classList.add("err"); return; }
      st.classList.remove("err");
      st.textContent = "导入中（import_document_file）…";
      const args = { knowledge_base_id: M.receipt.kb, upload_id: M.receipt.upload_id };
      const engine = section.querySelector("#m-engine").value;
      if (engine && engine !== "__default__") {
        const ext = (String(M.receipt.file_name || "").split(".").pop() || "pdf").toLowerCase();
        args.process_config = { parser_engine_rules: [{ file_types: [ext], engine }] };
      }
      const r = await api("/api/import", {
        method: "POST", json: args, headers: materialsHeaders(), brief: "import_document_file",
      });
      if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
      const res = (r.data && r.data.result) || {};
      const doc = res.document || {};
      if (!r.ok || !(r.data && r.data.ok)) {
        st.textContent = "导入失败：" + ((r.data && r.data.error) || r.error || r.status);
        st.classList.add("err");
        return;
      }
      M.doc = { id: doc.id || res.document_id || "", title: doc.title || "" };
      M.docStartedAt = Date.now();
      section.querySelector("#m-doc").textContent = M.doc.id || "–";
      const applied = res.process_config_applied;
      st.textContent = `已入队（queued=${res.queued} dedup=${res.deduplicated}` +
        (applied === undefined ? "" : ` · 解析选项${applied ? "已提交" : "未重新应用"}`) + "）";
      if (res.note && applied === false) st.textContent += " — " + res.note;
      saveLastImport();
      pollDocStatus(section);
    };

    // --- 新建知识库（建完自动刷新列表并选中）---
    section.querySelector("#m-kb-new").onclick = () => openKbCreateDialog(section);

    // --- 刷新后找回：知识库最近导入的文档 ---
    section.querySelector("#m-recent").onclick = () => showRecentDocs(section);

    M.mounted = true;
    M.engine = M.engine || "__default__";
    syncKbSelect(section);
    syncEngineSelect(section);
    restoreLastImport(section);
  }

  /* ---- 新建知识库：控制台里就能开新库，不必再去 WeKnora 后台 ---- */

  // openKbCreateDialog 打开建库弹窗（openModal 接收的是构建函数）。
  function openKbCreateDialog(section) {
    openModal(box => {
      const h = document.createElement("h3");
      h.textContent = "新建知识库";
      box.appendChild(h);
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = "经 MCP create_knowledge_base 创建：语义检索与关键词检索默认开启，Wiki / 图谱按需勾选。";
      box.appendChild(sub);

      const mkField = (label, placeholder, id) => {
        const lab = document.createElement("label");
        lab.className = "field";
        lab.innerHTML = `<span>${escapeHtml(label)}</span>`;
        const input = document.createElement("input");
        input.className = "input wide";
        input.id = id;
        input.placeholder = placeholder;
        lab.appendChild(input);
        box.appendChild(lab);
        return input;
      };
      const nameInput = mkField("知识库名称（必填）", "例如：演示知识库", "kb-new-name");
      const descInput = mkField("描述（可选）", "一句话说明这个库存什么", "kb-new-desc");

      const mkToggle = (label, id) => {
        const wrap = document.createElement("label");
        wrap.className = "kv";
        wrap.style.cssText = "display:flex;gap:6px;align-items:center";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.id = id;
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode(" " + label));
        box.appendChild(wrap);
        return cb;
      };
      const wikiToggle = mkToggle("同时生成 Wiki 页面", "kb-new-wiki");
      const graphToggle = mkToggle("同时抽取知识图谱", "kb-new-graph");

      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancel = document.createElement("button");
      cancel.className = "btn ghost";
      cancel.id = "kb-new-cancel";
      cancel.textContent = "取消";
      const ok = document.createElement("button");
      ok.className = "btn";
      ok.id = "kb-new-submit";
      ok.textContent = "创建";
      actions.append(cancel, ok);
      box.appendChild(actions);

      cancel.onclick = () => closeModal();
      ok.onclick = async () => {
        const name = nameInput.value.trim();
        if (!name) { toast("请填写知识库名称", "err"); return; }
        const epoch = captureIdentityEpoch();
        ok.disabled = true;
        ok.textContent = "创建中…";
        const r = await api("/api/tool", {
          method: "POST",
          json: { name: "create_knowledge_base", arguments: {
            name,
            description: descInput.value.trim(),
            enable_wiki: wikiToggle.checked,
            enable_graph: graphToggle.checked,
          } },
          headers: mcpHeaders(), brief: "新建知识库",
        });
        if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
        ok.disabled = false;
        ok.textContent = "创建";
        const d = r.data || {};
        if (!d.ok) {
          toast("新建失败：" + (d.error || r.error || r.status), "err");
          return;
        }
        const created = (d.result || {}).knowledge_base || {};
        closeModal();
        toast(`已创建知识库「${created.name || name}」`);
        const scope = (d.result || {}).endpoint_scope;
        if (scope && scope.added_to_endpoint_range === false) {
          toast("新库还没加入当前端点范围：" + (scope.message || ""), "err");
        }
        // 刷新列表并把这个新库选为上传目标，省得再点一次。
        await window.App.loadKbs();
        if (created.id) { S.uploadTargetKbId = created.id; saveScope(); }
        if (M.mounted) { syncKbSelect(section); syncEngineSelect(section); }
        renderScopeSummary();
      };
      nameInput.focus();
    });
  }

  // syncKbSelect 绑定「上传目标」单选框：它只影响资料页的请求范围。
  function syncKbSelect(section) {
    const sel = section.querySelector("#m-kb");
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = "";
    for (const kb of S.kbs) {
      const o = document.createElement("option");
      o.value = kb.id; o.textContent = kb.name;
      sel.appendChild(o);
    }
    const target = S.uploadTargetKbId || prev;
    if (target && S.kbs.some(k => k.id === target)) sel.value = target;
    else if (S.kbs.length) { sel.value = S.kbs[0].id; S.uploadTargetKbId = S.kbs[0].id; saveScope(); }
  }

  // syncEngineSelect 渲染解析引擎目录（含不可用原因），默认「使用知识库默认」。
  function syncEngineSelect(section) {
    const sel = section.querySelector("#m-engine");
    if (!sel) return;
    const prev = M.engine || sel.value || "__default__";
    sel.innerHTML = "";
    const def = document.createElement("option");
    def.value = "__default__";
    def.textContent = "使用知识库默认";
    sel.appendChild(def);
    for (const engine of S.engines || []) {
      const o = document.createElement("option");
      o.value = engine.name;
      const types = (engine.file_types || []).join("/");
      o.textContent = engine.available
        ? `${engine.name}${types ? " · " + types : ""}`
        : `${engine.name}（不可用：${engine.unavailable_reason || "未配置"}）`;
      o.disabled = !engine.available;
      sel.appendChild(o);
    }
    sel.value = [...sel.options].some(o => o.value === prev && !o.disabled) ? prev : "__default__";
    M.engine = sel.value;
    renderEngineNote(section);
  }

  function renderEngineNote(section) {
    const note = section.querySelector("#m-engine-note");
    if (!note) return;
    const chosen = M.engine && M.engine !== "__default__" ? M.engine : "";
    const info = (S.engines || []).find(e => e.name === chosen);
    if (!chosen) {
      note.textContent = S.engines.length
        ? `可选引擎 ${S.engines.filter(e => e.available).length} 个（当前使用知识库默认）`
        : "解析引擎目录不可用：端点未开放 list_parser_engines，将使用知识库默认";
    } else {
      note.textContent = `将以 ${chosen} 解析${info && info.file_types ? "（支持 " + info.file_types.join("/") + "）" : ""}；仅对本次导入生效`;
    }
  }

  /* ---- 上次导入记录：刷新页面后仍能找回文档与解析结果 ---- */
  const LAST_KEY = "wk.materials.last";

  function saveLastImport() {
    const p = window.App.activeProfile && window.App.activeProfile();
    if (!p || !M.receipt) return;
    try {
      sessionStorage.setItem(LAST_KEY, JSON.stringify({
        email: p.email, workspace: String(p.tenant_id || ""),
        receipt: M.receipt, doc: M.doc, engine: M.engine, at: Date.now(),
      }));
    } catch (_) { /* 私密模式等场景下写不进去就算了 */ }
  }
  function clearLastImport() {
    try { sessionStorage.removeItem(LAST_KEY); } catch (_) {}
  }
  function restoreLastImport(section) {
    const p = window.App.activeProfile && window.App.activeProfile();
    let rec = null;
    try { rec = JSON.parse(sessionStorage.getItem(LAST_KEY) || "null"); } catch (_) { rec = null; }
    if (!rec || !rec.receipt || !p) return;
    // 记录只属于写入它的那个身份，换了账号不能复活。
    if (rec.email !== p.email || String(rec.workspace) !== String(p.tenant_id || "")) return;
    M.receipt = rec.receipt;
    M.doc = rec.doc || null;
    M.docStartedAt = rec.at || null;   // 刷新后「已等待」从原始导入时间继续算
    if (rec.engine) M.engine = rec.engine;
    renderReceipt(section);
    section.querySelector("#m-import").disabled = false;
    const st = section.querySelector("#m-import-status");
    st.textContent = "已恢复上次导入记录（刷新前上传/导入的内容），下面显示它当前的状态";
    if (M.doc && M.doc.id) {
      section.querySelector("#m-doc").textContent = M.doc.id;
      pollDocStatus(section);
    }
  }

  const STATUS_CN = {
    pending: "排队中", queued: "排队中", running: "解析中", parsing: "解析中", processing: "解析中",
    indexing: "索引中", finalizing: "收尾中", summarizing: "生成摘要中",
    completed: "已完成", success: "已完成", failed: "失败", cancelled: "已取消",
    disabled: "已停用", empty: "无",
  };
  function parseStatusCN(s) {
    const key = String(s || "").toLowerCase();
    return STATUS_CN[key] || (s ? String(s) : "未知");
  }
  function doneStatus(s) { return ["completed", "failed", "cancelled"].includes(String(s || "").toLowerCase()); }

  // docPollSeq：新的轮询或新的文档会让旧的循环立刻退出，避免两个循环互相覆盖。
  let docPollSeq = 0;

  // pollDocStatus 轮询解析状态并回显 requested / applied 引擎，导入后可见。
  async function pollDocStatus(section) {
    const box = section.querySelector("#m-doc-status");
    const docId = M.doc && M.doc.id;
    if (!box || !docId) return;
    const seq = ++docPollSeq;
    const epoch = captureIdentityEpoch();
    // 有原始导入时间就接着它算等待时长（刷新后不清零）。
    const startedAt = M.docStartedAt || Date.now();
    M.docStartedAt = startedAt;
    let preview = M.preview && M.preview.id === docId ? M.preview : null;
    for (let i = 0; i < 100; i++) {
      const r = await api(`/api/document_status?knowledge_id=${encodeURIComponent(docId)}`,
        { headers: materialsHeaders(), brief: getDocTitle() });
      if (!isCurrentIdentityEpoch(epoch) || r.stale || seq !== docPollSeq) return;
      const status = ((r.data || {}).result || {}).status || {};
      const done = doneStatus(status.parse_status);
      if (done && !preview) {
        preview = await readDocPreview(section, docId, epoch, seq);
        M.preview = preview ? Object.assign({ id: docId }, preview) : null;
      }
      if (seq !== docPollSeq) return;
      renderDocProgress(section, status, {
        elapsed: Math.round((Date.now() - startedAt) / 1000),
        preview, done, timedOut: false,
      });
      if (done) return;
      await new Promise(res => setTimeout(res, i < 5 ? 1500 : 3000));
    }
    if (seq !== docPollSeq) return;
    const last = M.lastStatus || {};
    renderDocProgress(section, last, { elapsed: 300, preview, done: false, timedOut: true });
  }

  function getDocTitle() {
    return (M.doc && M.doc.title) || (M.receipt && M.receipt.file_name) || "document status";
  }

  // readDocPreview 读回解析结果的头一段：分块数 + 原文前 200 字，
  // 让人一眼看出「解析出什么了」（扫描件没开 OCR 时会明显为空）。
  async function readDocPreview(section, docId, epoch, seq) {
    const r = await api("/api/tool", {
      method: "POST",
      json: { name: "read_document", arguments: { knowledge_id: docId, limit: 1 } },
      headers: materialsHeaders(), brief: "读取解析结果",
    });
    if (!isCurrentIdentityEpoch(epoch) || r.stale || seq !== docPollSeq) return null;
    if (!r.ok || !(r.data && r.data.ok)) return { total: null, text: "", error: (r.data && r.data.error) || r.error };
    const d = (r.data.result) || {};
    const chunk = (d.chunks || [])[0] || {};
    return {
      total: d.total_chunks != null ? d.total_chunks : ((d.document || {}).chunk_count ?? null),
      fetched: d.fetched_chunks != null ? d.fetched_chunks : null,
      text: String(chunk.content || "").replace(/\s+/g, " ").trim().slice(0, 200),
    };
  }

  // renderDocProgress 把状态画成一块「看得懂」的进度面板。
  function renderDocProgress(section, status, ctx) {
    const box = section.querySelector("#m-doc-status");
    if (!box) return;
    M.lastStatus = status;
    const requested = Array.isArray(status.requested_parser_engine_rules) && status.requested_parser_engine_rules.length
      ? status.requested_parser_engine_rules.map(x => `${(x.file_types || []).join("/")}→${x.engine}`).join("; ")
      : "知识库默认";
    const parse = status.parse_status || "?";
    const idx = status.index_status || "?";
    const head = ctx.done
      ? (parse === "completed"
        ? `✅ 解析完成（${ctx.elapsed}s）· 索引${parseStatusCN(idx)}，可去「知识问答」提问`
        : `⚠️ 解析${parseStatusCN(parse)}`)
      : `⏳ 解析中，已等待 ${ctx.elapsed}s（4 页扫描件通常 1–2 分钟）`;
    const cells = [
      ["解析", parseStatusCN(parse)],
      ["索引", parseStatusCN(idx)],
      ["请求引擎", requested],
      ["实际引擎", status.applied_parser_engine || "（解析开始后显示）"],
      ["文件类型", status.file_type || "–"],
      ["最后更新", String(status.updated_at || status.processed_at || "–").slice(0, 19).replace("T", " ")],
    ];
    const previewLine = ctx.preview
      ? (ctx.preview.error
        ? `<div class="kv err-text">读取解析结果失败：${escapeHtml(String(ctx.preview.error))}</div>`
        : `<div class="kv">分块数：<b>${ctx.preview.total != null ? ctx.preview.total : "?"}</b>
           ${ctx.preview.text ? `· 预览：<span class="dp-quote">${escapeHtml(ctx.preview.text)}…</span>`
             : "· 这一段没有文字（扫描件需开启 OCR / 图像理解）"}</div>`)
      : "";
    box.innerHTML = `
      <div class="doc-progress">
        <div class="dp-head">${escapeHtml(head)}</div>
        <div class="dp-grid">${cells.map(([k, v]) =>
          `<div class="dp-cell"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join("")}</div>
        ${status.error_message ? `<div class="kv err-text">错误：${escapeHtml(status.error_message)}</div>` : ""}
        ${ctx.timedOut ? '<div class="kv">等待超过 5 分钟仍在解析，可点下面的「刷新状态」继续看。</div>' : ""}
        ${previewLine}
        <div class="dp-actions">
          <button id="m-status-refresh" class="btn ghost small">刷新状态</button>
          <button id="m-status-forget" class="btn ghost small">清除这条记录</button>
        </div>
      </div>`;
    box.querySelector("#m-status-refresh").onclick = () => pollDocStatus(section);
    box.querySelector("#m-status-forget").onclick = () => {
      docPollSeq++;              // 让在飞的轮询循环退出
      clearLastImport();
      M.receipt = null; M.doc = null; M.preview = null;
      section.querySelector("#m-receipt").innerHTML = "";
      section.querySelector("#m-doc").textContent = "–";
      section.querySelector("#m-import-status").textContent = "";
      section.querySelector("#m-doc-status").innerHTML = "";
      section.querySelector("#m-import").disabled = true;
    };
  }

  // showRecentDocs 兜底：刷新后没记录时，直接看目标知识库里最近导入的文档。
  async function showRecentDocs(section) {
    const box = section.querySelector("#m-recent-list");
    const kb = S.uploadTargetKbId || section.querySelector("#m-kb").value;
    const epoch = captureIdentityEpoch();
    if (!kb) { toast("请先选择目标知识库", "err"); return; }
    box.innerHTML = '<div class="kv">查询中…</div>';
    const r = await api("/api/tool", {
      method: "POST",
      json: { name: "list_documents", arguments: { knowledge_base_id: kb, page_size: 8 } },
      headers: materialsHeaders(), brief: "列出最近导入",
    });
    if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
    const docs = ((r.data && r.data.result) || {}).documents || [];
    if (!r.ok || !(r.data && r.data.ok)) {
      box.innerHTML = `<div class="kv err-text">查询失败：${escapeHtml(String((r.data && r.data.error) || r.error))}</div>`;
      return;
    }
    if (!docs.length) { box.innerHTML = '<div class="kv">这个知识库里还没有文档。</div>'; return; }
    box.innerHTML = `<div class="kv">最近导入（点一行即可查看它的解析结果）：</div>
      <div class="recent-docs">${docs.map((d, i) => `
        <button class="recent-doc" data-i="${i}">
          <span class="rd-title">${escapeHtml(d.title || d.file_name || d.id)}</span>
          <span class="rd-meta">${escapeHtml(parseStatusCN(d.parse_status))} · ${escapeHtml(String(d.updated_at || d.created_at || "").slice(0, 19).replace("T", " "))}</span>
        </button>`).join("")}</div>`;
    box.querySelectorAll(".recent-doc").forEach(btn => {
      btn.onclick = () => {
        const d = docs[Number(btn.dataset.i)];
        M.receipt = Object.assign({}, M.receipt || {}, { kb });
        M.doc = { id: d.id, title: d.title || d.file_name || "" };
        M.preview = null;
        section.querySelector("#m-doc").textContent = M.doc.id;
        section.querySelector("#m-import-status").textContent = `正在查看：${M.doc.title || M.doc.id}`;
        section.querySelector("#m-recent-list").innerHTML = "";
        saveLastImport();
        pollDocStatus(section);
      };
    });
  }


  function renderReceipt(section) {
    const box = section.querySelector("#m-receipt");
    const r = M.receipt;
    if (!r) { box.innerHTML = ""; return; }
    box.innerHTML = `
      <div class="receipt">
        <div class="kv">通道 <b>${escapeHtml(r.channel)}</b> · upload_id <b class="mono">${escapeHtml(r.upload_id || "")}</b>
        ${r.replay ? '· <b>replay=true</b>（幂等重放）' : ""}</div>
        <div class="kv">file <b>${escapeHtml(r.file_name || "")}</b> · size <b>${r.file_size ?? "?"}</b> ·
        sha256 <span class="mono">${escapeHtml(String(r.sha256 || "").slice(0, 16))}…</span> ·
        expires <b>${escapeHtml(String(r.expires_at || "").slice(0, 19))}</b></div>
      </div>`;
  }

  async function runChecklist(section) {
    const epoch = captureIdentityEpoch();
    const kb = (M.receipt && M.receipt.kb) || S.uploadTargetKbId ||
      (section.querySelector("#m-kb") ? section.querySelector("#m-kb").value : "");
    if (!kb) { toast("请选择目标知识库", "err"); return; }
    if (!window.App.activeProfile()) { toast("请先配置有效 Token", "err"); return; }
    const body = { knowledge_base_id: kb };
    if (M.doc && M.doc.id) body.knowledge_id = M.doc.id;
    if (M.receipt) body.upload_id = M.receipt.upload_id;
    const table = section.querySelector("#m-checklist");
    const summaryEl = section.querySelector("#m-summary");
    M.steps = []; M.summary = null;
    section.querySelector("#m-download").disabled = true;
    table.innerHTML = `<table class="tbl"><thead><tr><th style="width:34px">#</th><th style="width:210px">工具</th>
      <th style="width:86px">状态</th><th style="width:84px">耗时</th><th>摘要</th></tr></thead><tbody></tbody></table>
      <div id="m-cl-progress" class="status-line cursor">清单运行中：正在轮询解析状态（大文件可能耗时数分钟）…</div>`;
    const tbody = table.querySelector("tbody");
    let idx = 0;
    try {
      await sse("/api/checklist", body, evt => {
        // 身份已切换：清单的后续步骤与 DOM 一律丢弃（sse() 也会停止投递）。
        if (!isCurrentIdentityEpoch(epoch)) return;
        if (evt.type === "step") {
          idx += 1;
          M.steps.push(evt);
          const tr = document.createElement("tr");
          const badgeCls = evt.status === "pass" ? "ok" : (evt.status === "fail" ? "err" : "gray");
          const badgeTxt = evt.status === "pass" ? "✓ 通过" : (evt.status === "fail" ? "✗ 失败" : "– 跳过");
          tr.innerHTML = `<td>${idx}</td><td class="mono">${escapeHtml(evt.tool)}</td>
            <td><span class="badge ${badgeCls}">${badgeTxt}</span></td>
            <td class="mono">${evt.latency_ms}ms</td>
            <td><div>${escapeHtml(evt.summary || "")}</div>
            <span class="raw-toggle">原始响应</span><div class="raw-holder hidden"></div></td>`;
          const holder = tr.querySelector(".raw-holder");
          const pre = document.createElement("pre");
          pre.className = "raw";
          pre.textContent = JSON.stringify(evt.raw, null, 2);
          holder.appendChild(pre);
          tr.querySelector(".raw-toggle").onclick = () => holder.classList.toggle("hidden");
          tbody.appendChild(tr);
          if (evt.tool === "get_document_status") {
            const p = table.querySelector("#m-cl-progress");
            if (p) p.textContent = evt.status === "pass" ? "解析完成。" : `解析状态：${evt.summary || ""}`;
          }
        } else if (evt.type === "done") {
          M.summary = evt.summary;
          summaryEl.classList.remove("err");
          const { pass, fail, skip } = evt.summary || {};
          summaryEl.textContent = `合计：通过 ${pass} · 失败 ${fail} · 跳过 ${skip}`;
          if (fail) summaryEl.classList.add("err");
          section.querySelector("#m-download").disabled = false;
        }
      });
    } catch (e) {
      if (!isCurrentIdentityEpoch(epoch)) return;
      toast("清单运行失败：" + e.message, "err");
    } finally {
      if (!isCurrentIdentityEpoch(epoch)) return;
      const p = table.querySelector("#m-cl-progress");
      if (p) p.classList.remove("cursor");
    }
  }

  /* ===================== 视图二：问答 ===================== */
// Q.scopeAll/qbIds/mode 由 app.js 的状态渲染；问答只走 WeKnora 原生 ask。
  const Q = { sessionId: "", busy: false, mounted: false };

  function qaScopeChips(section) {
    const box = section.querySelector("#qa-kbs");
    if (!box) return;
    box.innerHTML = "";
    if (!window.App.activeProfile()) {
      box.innerHTML = '<span class="muted">配置有效 Token 后加载知识库</span>';
      return;
    }
    const all = document.createElement("span");
    all.className = "chip" + (S.qaScopeAll ? " on" : "");
    all.textContent = "全部可用（不额外收窄）";
    all.title = "显式选择此项时不发送知识库范围头，按端点权限检索全部可见库";
    all.onclick = () => { S.qaScopeAll = !S.qaScopeAll; saveScope(); setQaScopeChanged(section); };
    box.appendChild(all);
    for (const kb of S.kbs) {
      const on = !S.qaScopeAll && S.qaKbIds.includes(kb.id);
      const chip = document.createElement("span");
      chip.className = "chip" + (on ? " on" : "");
      chip.textContent = kb.name;
      chip.title = kb.id;
      chip.onclick = () => {
        if (S.qaScopeAll) S.qaScopeAll = false;
        S.qaKbIds = on ? S.qaKbIds.filter(id => id !== kb.id) : S.qaKbIds.concat([kb.id]);
        saveScope();
        setQaScopeChanged(section);
      };
      box.appendChild(chip);
    }
  }

  // 问答范围/模式一变：开新会话、推进 qaEpoch（旧回答不得写回新范围）。
  function setQaScopeChanged(section) {
    window.App.advanceQaEpoch();
    qaScopeChips(section);
    renderScopeSummary();
    renderQaScopeLine(section);
    updateQaSendState(section);
    const label = section.querySelector("#qa-session");
    if (label) label.textContent = "–";
    const msgs = section.querySelector("#qa-msgs");
    if (msgs) msgs.innerHTML = '<div class="empty">已按新的问答范围开启新会话。</div>';
  }

  function renderQaScopeLine(section) {
    const line = section.querySelector("#qa-scope-line");
    if (!line) return;
    const nameOf = id => (S.kbs.find(k => k.id === id) || {}).name || id.slice(0, 8);
    if (S.qaScopeAll) line.textContent = "检索范围：全部可用知识库（不额外收窄）";
    else if (S.qaKbIds.length) line.textContent = "检索范围：" + S.qaKbIds.map(nameOf).join("、");
    else line.textContent = "检索范围：未选择 —— 请先选择至少一个知识库（或选择「全部可用」）";
  }

  function qaScopeChosen() {
    return S.qaScopeAll || S.qaKbIds.length > 0;
  }

  function updateQaSendState(section) {
    const send = section.querySelector("#qa-send");
    const input = section.querySelector("#qa-q");
    if (!send) return;
    const ready = qaScopeChosen() && !!window.App.activeProfile();
    send.disabled = !ready || Q.busy;
    if (input) input.placeholder = ready
      ? "输入问题，Enter 发送（Shift+Enter 换行）"
      : "先选择问答知识库范围再提问";
  }

  function qaMount(section) {
    section.innerHTML = `
      <div class="card">
        <div class="row">
          <label class="field grow"><span>检索知识库范围（问答页独立于资料页上传目标）</span>
            <div id="qa-kbs" class="chips"></div></label>
        </div>
        <div class="row"><span id="qa-scope-line" class="kv"></span></div>
      </div>
      <div class="card">
        <div class="row">
          <label class="field grow"><span>WeKnora 原生问答模式</span>
            <div class="seg" id="qa-mode">
              <button data-mode="" class="on">端点默认</button>
              <button data-mode="quick-answer">原生快速问答</button>
              <button data-mode="smart-reasoning">原生智能推理</button>
            </div></label>
          <span class="grow"></span>
          <span class="kv">session：<b id="qa-session" class="mono">–</b></span>
          <button id="qa-new" class="btn ghost small">新会话</button>
        </div>
        <div class="sub" id="qa-hint">模式经 MCP <span class="mono">ask</span> 的 mode 参数提交，由 WeKnora 校验生效；
        「端点默认」使用端点配置的 agent（本控制台只走 WeKnora 自己的问答链，不再内置其他编排框架）。</div>
      </div>
      <div id="qa-msgs"><div class="empty">还没有对话。选择范围后输入问题开始。</div></div>
      <div class="card">
        <div class="row">
          <textarea id="qa-q" class="input grow" rows="2" placeholder="先选择问答知识库范围再提问"></textarea>
          <button id="qa-send" class="btn" disabled>发送</button>
        </div>
        <div class="row qa-examples">
          <span class="kv">示例问题（配合《WeKnora-PDF验收样本-青岚计划》这份资料，点一下即填入）：</span>
          <div class="chips" id="qa-examples"></div>
        </div>
      </div>`;

    section.querySelectorAll("#qa-mode button").forEach(btn => {
      btn.onclick = () => {
        S.qaMode = btn.dataset.mode || "";
        saveScope();
        section.querySelectorAll("#qa-mode button").forEach(b => b.classList.toggle("on", b === btn));
        setQaScopeChanged(section);
      };
    });
    section.querySelector("#qa-new").onclick = () => {
      Q.sessionId = "";
      section.querySelector("#qa-session").textContent = "–";
      section.querySelector("#qa-msgs").innerHTML = '<div class="empty">已开新会话。</div>';
    };
    const input = section.querySelector("#qa-q");
    // 示例问题：覆盖文字页、表格页与扫描页，演示时点一下就填好。
    const EX_QUESTIONS = [
      "青岚计划的项目编号、资料识别标记、负责人和复核人分别是什么？",
      "批次 A-17 的合格率是多少？请给出分子、分母与计算过程。",
      "三个批次分别能否放行？请逐项比较合格率与峰值温度。",
      "第 3 页扫描交接单的交接口令、箱数和关联批次是什么？",
      "青岚计划的年度预算是多少？如果资料里没有，请明确说明。",
    ];
    const exBox = section.querySelector("#qa-examples");
    if (exBox) {
      for (const q of EX_QUESTIONS) {
        const chip = document.createElement("button");
        chip.className = "chip";
        chip.type = "button";
        chip.textContent = q;
        chip.title = "点击填入问题";
        chip.onclick = () => { input.value = q; input.focus(); };
        exBox.appendChild(chip);
      }
    }
    section.querySelector("#qa-send").onclick = () => qaAsk(section);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); qaAsk(section); }
    });
    // 初始渲染：范围 chips、模式按钮、会话状态
    section.querySelectorAll("#qa-mode button").forEach(b => {
      b.classList.toggle("on", (b.dataset.mode || "") === (S.qaMode || ""));
    });
    qaScopeChips(section);
    renderQaScopeLine(section);
    updateQaSendState(section);
    Q.mounted = true;
  }

  // stripThinking removes the model's reasoning wrapper from a final answer:
  // MiniMax-style vendors inline  thinking… into the content channel and
  // it must never be shown as the user-facing answer.
  function stripThinking(text) {
    return String(text || "")
      .replace(/<think[\s\S]*?<\/think>/gi, "")
      .replace(/<thinking[\s\S]*?<\/thinking>/gi, "")
      .trim();
  }

  // renderCitations converts the answer's <kb doc="…" chunk_id="…" kb_id="…"/>
  // markers into readable citation chips and reports which knowledge ids were
  // actually cited, so the reference list can mark cited vs candidate sources.
  function renderCitations(text) {
    const citedKnowledge = new Set();
    const citedChunks = new Set();
    const cleaned = String(text || "").replace(
      /<kb\s+([^>]*?)\/?>/gi,
      (match, attrs) => {
        const doc = (attrs.match(/doc="([^"]*)"/) || [])[1] || "";
        const chunk = (attrs.match(/chunk_id="([^"]*)"/) || [])[1] || "";
        const kbId = (attrs.match(/kb_id="([^"]*)"/) || [])[1] || "";
        if (kbId) citedKnowledge.add(kbId);
        if (chunk) citedChunks.add(chunk);
        const label = doc || (chunk ? chunk.slice(0, 8) : "来源");
        return ` ⟦引用: ${label}⟧`;
      });
    return { text: cleaned, citedKnowledge, citedChunks };
  }

  async function qaAsk(section) {
    if (Q.busy) return;
    const identityEpoch = captureIdentityEpoch();
    const scopeEpoch = window.App.captureQaEpoch();
    if (!window.App.activeProfile()) { toast("请先配置有效 Token", "err"); return; }
    if (!qaScopeChosen()) { toast("请先选择问答知识库范围（或「全部可用」）", "err"); return; }
    const input = section.querySelector("#qa-q");
    const question = input.value.trim();
    if (!question) return;
    Q.busy = true;
    updateQaSendState(section);
    const msgs = section.querySelector("#qa-msgs");
    if (msgs.querySelector(".empty")) msgs.innerHTML = "";

    const userRow = document.createElement("div");
    userRow.className = "msg user";
    userRow.innerHTML = `<div class="bubble">${escapeHtml(question)}</div>`;
    msgs.appendChild(userRow);
    input.value = "";

    const aiRow = document.createElement("div");
    aiRow.className = "msg ai";
    aiRow.innerHTML = `<div class="bubble"><div class="tools"></div>
      <div class="status-line cursor">思考中…</div><div class="answer"></div><div class="refs"></div></div>`;
    msgs.appendChild(aiRow);
    const toolsEl = aiRow.querySelector(".tools");
    const statusEl = aiRow.querySelector(".status-line");
    const answerEl = aiRow.querySelector(".answer");
    const refsEl = aiRow.querySelector(".refs");
    msgs.scrollTop = msgs.scrollHeight;

    const stale = () => !isCurrentIdentityEpoch(identityEpoch) || !window.App.isCurrentQaEpoch(scopeEpoch);
    const finish = () => {
      if (stale()) return;
      statusEl.classList.remove("cursor");
      if (!answerEl.textContent.trim() && !statusEl.textContent.trim()) statusEl.remove();
      Q.busy = false;
      updateQaSendState(section);
    };

    try {
      // 只用 WeKnora 自己的问答链：原生 ask（mode 经 MCP 参数提交）。
      const payload = { question, session_id: Q.sessionId || undefined };
      if (S.qaMode) payload.mode = S.qaMode;
      await sse("/api/ask", payload, evt => {
        if (stale()) return;
        if (evt.type === "status") statusEl.textContent = evt.text;
        else if (evt.type === "answer") {
          statusEl.remove();
          const answer = stripThinking(evt.text);
          const rendered = renderCitations(answer);
          answerEl.innerHTML = renderMarkdown(rendered.text);
          const meta = [];
          if (evt.mode) meta.push(`模式 ${evt.mode}`);
          if (Array.isArray(evt.knowledge_base_ids) && evt.knowledge_base_ids.length) {
            meta.push(`范围 ${evt.knowledge_base_ids.length} 库`);
          }
          if (meta.length) {
            const badge = document.createElement("div");
            badge.className = "kv";
            badge.textContent = meta.join(" · ");
            refsEl.appendChild(badge);
          }
          if (evt.session_id) {
            Q.sessionId = evt.session_id;
            section.querySelector("#qa-session").textContent = evt.session_id.slice(0, 12) + "…";
          }
          attachmentsForRefs(refsEl, evt.references || [], rendered);
        } else if (evt.type === "error") {
          statusEl.textContent = evt.message || "调用失败";
          statusEl.classList.add("err");
        }
      }, window.App.qaHeaders());
    } catch (e) {
      if (!stale()) {
        statusEl.textContent = "连接失败：" + e.message;
        statusEl.classList.add("err");
      }
    } finally {
      finish();
      msgs.scrollTop = msgs.scrollHeight;
    }
  }

  // attachmentsForRefs renders reference cards, separating the sources the
  // answer actually cited from the remaining retrieval candidates.
  function attachmentsForRefs(refsEl, references, rendered) {
    if (!references || !references.length) return;
    const cited = [];
    const candidates = [];
    for (const ref of references) {
      const isCited = (ref.knowledge_id && rendered.citedKnowledge.has(ref.knowledge_id)) ||
        (ref.chunk_id && rendered.citedChunks.has(ref.chunk_id));
      (isCited ? cited : candidates).push(ref);
    }
    const add = (ref, kind) => {
      const card = document.createElement("div");
      card.className = "ref-card";
      const mark = kind === "cited" ? "✓ 已引用" : "候选（未被本次回答引用）";
      card.innerHTML = `<div class="t">${escapeHtml(ref.knowledge_title || ref.title || "引用")}
        <span class="muted" style="font-size:11px"> · ${mark}</span></div>
        <div>${escapeHtml(stripThinking(ref.excerpt || "").slice(0, 220))}</div>
        <div class="meta">chunk ${escapeHtml(String(ref.chunk_id || "").slice(0, 12))}… · score ${ref.score ?? "-"}</div>`;
      refsEl.appendChild(card);
    };
    cited.forEach(ref => add(ref, "cited"));
    if (candidates.length) {
      const details = document.createElement("details");
      details.innerHTML = `<summary class="muted" style="font-size:12px">另有 ${candidates.length} 条候选资料未被本次回答引用</summary>`;
      const inner = document.createElement("div");
      inner.className = "refs";
      details.appendChild(inner);
      refsEl.appendChild(details);
      candidates.forEach(ref => {
        const card = document.createElement("div");
        card.className = "ref-card";
        card.innerHTML = `<div class="t">${escapeHtml(ref.knowledge_title || ref.title || "候选")}</div>
          <div class="meta">chunk ${escapeHtml(String(ref.chunk_id || "").slice(0, 12))}… · score ${ref.score ?? "-"}</div>`;
        inner.appendChild(card);
      });
    }
  }

  const B = { tool: null, mounted: false, formMode: "form", formInputs: {}, jsonText: "" };

  function groupOf(name) {
    if (name.startsWith("wiki_")) return "Wiki";
    if (name.includes("graph")) return "图谱";
    if (name.includes("status")) return "状态";
    if (name.includes("upload") || name.includes("import")) return "上传 / 导入";
    if (name.includes("document") && (name.startsWith("add") || name.startsWith("update") || name.startsWith("delete"))) return "写操作";
    if (name === "list_knowledge_bases" || name === "list_documents") return "发现";
    return "检索 / 读取";
  }

  function benchMount(section) {
    section.innerHTML = `
      <div class="card">
        <h3>开发诊断</h3>
        <div class="sub">这一页给开发和验证用，普通演示流程在「资料解析」和「知识问答」两页即可完成。<br>
        用法：左边挑一个工具 → 中间填参数（表单或 JSON）→ 点「运行」→ 下方看中文结论和原始返回。
        所有调用都走真实的 MCP 工具，右上角「MCP 调用轨迹」里有原始请求。</div>
      </div>
      <div class="bench">
        <div class="card">
          <h3>工具目录</h3>
          <div class="sub">共 <b id="b-count">0</b> 个工具，来自 MCP <span class="mono">tools/list</span>（配置 Token 后加载）。标「写」的会修改知识库数据，运行前会二次确认。</div>
          <input id="b-filter" class="input wide" placeholder="按中文名或工具名过滤…">
          <div class="tool-list" id="b-list" style="margin-top:10px"></div>
        </div>
        <div class="card">
          <div id="b-detail"><div class="empty">从左侧选择一个工具，这里会显示它能做什么、需要填什么</div></div>
        </div>
      </div>
      <div class="card">
        <h3>MCP 验证清单</h3>
        <div class="sub">对着「上传目标知识库」（或最近导入的那篇文档）把只读工具跑一遍：查状态 → 读原文 → 列文档 → 检索 → Wiki → 图谱 → 知识库状态。
        知识库没开启的能力会自动跳过并写明原因；红色叉才是工具本身失败。</div>
        <div class="row">
          <button id="m-run-checklist" class="btn ghost">运行 / 重跑清单</button>
          <span id="m-summary" class="status-line"></span>
          <span class="grow"></span>
          <button id="m-download" class="btn ghost" disabled>下载清单 JSON</button>
        </div>
        <div id="m-checklist"><div class="empty">在资料页完成一次导入后自动运行；也可在此直接验证已有文档。</div></div>
      </div>`;
    section.querySelector("#b-filter").oninput = e => renderToolList(section, e.target.value.trim().toLowerCase());
    section.querySelector("#m-run-checklist").onclick = () => runChecklist(section);
    section.querySelector("#m-download").onclick = () => downloadChecklist(section);
    B.mounted = true;
    renderToolList(section, "");
  }

  // downloadChecklist 导出最近一次清单结果（即用即弃 + 一键下载）。
  function downloadChecklist(section) {
    const payload = {
      generated_at: new Date().toISOString(),
      endpoint: (S.endpoint && S.endpoint.endpoint_id) || "",
      knowledge_base_id: (M.receipt && M.receipt.kb) || S.uploadTargetKbId || "",
      knowledge_id: (M.doc && M.doc.id) || "",
      upload_id: (M.receipt && M.receipt.upload_id) || "",
      summary: M.summary, steps: M.steps,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `mcp-checklist-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function renderToolList(section, filter) {
    const list = section.querySelector("#b-list");
    const counter = section.querySelector("#b-count");
    if (counter) counter.textContent = String(S.tools.length);
    list.innerHTML = "";
    if (!S.tools.length) { list.innerHTML = '<div class="empty">登录后加载工具目录</div>'; return; }
    const groups = {};
    for (const t of S.tools) {
      const [cn, desc] = toolCN(t.name);
      const hay = `${t.name} ${cn} ${desc}`.toLowerCase();
      if (filter && !hay.includes(filter)) continue;
      (groups[groupOf(t.name)] = groups[groupOf(t.name)] || []).push(t);
    }
    for (const [g, items] of Object.entries(groups)) {
      const h = document.createElement("div");
      h.className = "tool-group"; h.textContent = `${g}（${items.length}）`;
      list.appendChild(h);
      for (const t of items) {
        const [cn, desc] = toolCN(t.name);
        const btn = document.createElement("button");
        btn.className = "tool-item" + (B.tool && B.tool.name === t.name ? " on" : "");
        btn.title = desc || t.description || "";
        btn.innerHTML = `<span class="tool-cn">${escapeHtml(cn)}<span class="tool-en mono">${escapeHtml(t.name)}</span></span>` +
          (t.destructive ? '<span class="destructive">写</span>' : "");
        btn.onclick = () => { B.tool = t; renderToolDetail(section); renderToolList(section, filter); };
        list.appendChild(btn);
      }
    }
    if (!list.children.length) list.innerHTML = '<div class="empty">没有匹配的工具</div>';
  }

  function renderToolDetail(section) {
    const box = section.querySelector("#b-detail");
    const t = B.tool;
    const [cn, desc] = toolCN(t.name);
    box.innerHTML = `
      <h3>${escapeHtml(cn)} <span class="mono small muted">${escapeHtml(t.name)}</span>
        ${t.destructive ? '<span class="badge err">会改数据</span>' : '<span class="badge ok">只读</span>'}</h3>
      <div class="sub">${escapeHtml(desc || "（暂无中文说明）")}</div>
      <details class="token-help"><summary>接口原始描述（MCP 契约，英文）</summary>
        <p>${escapeHtml(t.description || "（无描述）")}</p></details>
      <div class="row" style="align-items:center">
        <button id="b-example" class="btn ghost small">填入示例</button>
        <span id="b-example-note" class="kv">示例会用当前知识库的真实 id 填好参数，直接点「运行」就能看到结果。</span>
      </div>
      <div class="row">
        <div class="seg" id="b-mode"><button data-m="form" class="on">表单</button><button data-m="json">JSON 编辑</button></div>
        <span class="grow"></span>
        <button id="b-run" class="btn${t.destructive ? " danger" : ""}">运行</button>
      </div>
      <div id="b-form" class="bench-form" style="margin-top:12px"></div>
      <div id="b-json" class="hidden"><textarea id="b-json-text" class="input wide mono" rows="8"></textarea></div>
      <div id="b-status" class="status-line" style="margin-top:10px"></div>
      <div id="b-result" class="result-pane" style="margin-top:10px"></div>`;
    B.formMode = "form";
    B.formInputs = {};
    buildForm(box.querySelector("#b-form"), t.inputSchema || {});
    box.querySelectorAll("#b-mode button").forEach(btn => {
      btn.onclick = () => {
        B.formMode = btn.dataset.m;
        box.querySelectorAll("#b-mode button").forEach(b => b.classList.toggle("on", b === btn));
        const isForm = B.formMode === "form";
        box.querySelector("#b-form").classList.toggle("hidden", !isForm);
        box.querySelector("#b-json").classList.toggle("hidden", isForm);
        if (!isForm) box.querySelector("#b-json-text").value = JSON.stringify(readForm(), null, 2);
        else buildForm(box.querySelector("#b-form"), t.inputSchema || {});
      };
    });
    box.querySelector("#b-example").onclick = () => fillToolExample(section, box);
    box.querySelector("#b-run").onclick = () => runBenchTool(section, box);
  }

  function buildForm(container, schema) {
    container.innerHTML = "";
    B.formInputs = {};
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    if (!Object.keys(props).length) {
      container.innerHTML = '<div class="muted">该工具没有参数。</div>';
      return;
    }
    for (const [name, spec] of Object.entries(props)) {
      const label = document.createElement("label");
      label.className = "field";
      const req = required.has(name) ? ' <span class="req">*</span>' : "";
      const cn = fieldCN(name);
      const enumHint = Array.isArray(spec.enum) ? `可选：${spec.enum.join(" / ")}` : "";
      label.innerHTML = `<span>${cn ? `${escapeHtml(cn)} ` : ""}<span class="mono muted">${escapeHtml(name)}</span>
        <span class="muted">(${escapeHtml(spec.type || "any")})</span>${req}</span>
        <span class="muted" style="font-size:11px">${escapeHtml(spec.description || enumHint || "")}</span>`;
      let el;
      if (Array.isArray(spec.enum)) {
        el = document.createElement("select"); el.className = "input wide";
        for (const v of spec.enum) {
          const o = document.createElement("option"); o.value = String(v); o.textContent = String(v); el.appendChild(o);
        }
      } else if (spec.type === "boolean") {
        el = document.createElement("input"); el.type = "checkbox";
      } else if (spec.type === "number" || spec.type === "integer") {
        el = document.createElement("input"); el.type = "number"; el.className = "input wide";
      } else if (spec.type === "array") {
        el = document.createElement("textarea"); el.className = "input wide mono"; el.rows = 2;
        el.placeholder = "每行一个值（或逗号分隔）";
      } else if (["content", "question", "text", "query"].includes(name) || (spec.type === "string" && (spec.maxLength || 0) > 500)) {
        el = document.createElement("textarea"); el.className = "input wide"; el.rows = 3;
      } else {
        el = document.createElement("input"); el.className = "input wide";
      }
      label.appendChild(el);
      container.appendChild(label);
      B.formInputs[name] = { el, spec };
    }
  }

  function readForm() {
    const args = {};
    for (const [name, { el, spec }] of Object.entries(B.formInputs)) {
      if (spec.type === "boolean") {
        if (el.checked) args[name] = true;
        continue;
      }
      const raw = (el.value || "").trim();
      if (!raw) continue;
      if (spec.type === "array") {
        args[name] = raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
      } else if (spec.type === "number" || spec.type === "integer") {
        args[name] = Number(raw);
      } else {
        args[name] = raw;
      }
    }
    return args;
  }

  /* ---- 每个工具的「能真跑出结果」示例 ---- */

  // TOOL_EXAMPLE_NOTE 说明点「填入示例」后跑出来的是什么，方便演示时讲。
  const TOOL_EXAMPLE_NOTE = {
    list_knowledge_bases: "当前身份可见的知识库，以及每个库开启了哪些能力。",
    create_knowledge_base: "新建一个知识库（默认开语义 + 关键词，可勾选 Wiki / 图谱），返回它的 id。",
    list_parser_engines: "本部署真实可用的解析引擎，以及各自支持的文件类型。",
    list_documents: "目标知识库里最近的文档（含解析状态）。",
    get_document_status: "某篇文档的解析/索引进度，以及请求与实际使用的解析引擎。",
    read_document: "某篇文档解析出来的正文（示例取第 1 段）。",
    search_knowledge: "语义+关键词检索的命中分块与来源文档。",
    grep_chunks: "在分块里做字面匹配的结果，适合核对编号、金额。",
    ask: "一次原生问答，返回带引用的回答。",
    get_knowledge_base_status: "知识库规模与能力可用性（文档数、分块数、Wiki/图谱是否就绪）。",
    get_upload_status: "某个 upload_id 的暂存状态。",
    upload_file: "把一段 Markdown 文本作为文件暂存，返回 upload_id。",
    import_document_file: "把暂存的文件变成正式文档并触发解析。",
    add_document: "新建一篇 Markdown 文档（会真的写进知识库）。",
    update_document: "替换某篇文档的正文，随后重新索引。",
    delete_document: "删除文档及其索引（不可撤销，示例指向演示文档）。",
    wiki_index: "Wiki 的分组与页面清单。",
    wiki_list_pages: "按类型/状态分页列出 Wiki 页面。",
    wiki_read_page: "单个 Wiki 页面的正文与引用。",
    wiki_search: "在 Wiki 页面里检索。",
    wiki_graph: "Wiki 页面之间的关系边。",
    query_knowledge_graph: "知识图谱的实体/关系（该库没开启图谱时返回空）。",
  };

  // EX 缓存示例用到的真实 id，避免每次点「填入示例」都重查一遍。
  const EX = { kbId: "", docId: "", docTitle: "", docWord: "" };

  function exampleKbId() {
    return S.uploadTargetKbId || (S.kbs[0] && S.kbs[0].id) || "";
  }

  // exampleKbFor 挑一个真正开启了某项能力的知识库：Wiki / 图谱示例如果落到没
  // 开该能力的库上，工具必然报「未配置」，那不是工具坏了而是挑错了库。
  function exampleKbFor(capability) {
    const kbs = S.kbs || [];
    const has = k => !!(k.capability_flags || {})[capability];
    // 当前上传目标如果有这项能力就用它（演示时选中的库优先），否则挑第一个具备该能力的。
    const target = kbs.find(k => k.id === S.uploadTargetKbId && has(k));
    return target || kbs.find(has) || null;
  }

  function capabilityHint(toolName, errorText) {
    const text = String(errorText || "");
    const needsGraph = /graph/i.test(toolName) || /GRAPH_/.test(text);
    const needsWiki = /^wiki_/.test(toolName);
    if (!needsGraph && !needsWiki) return "";
    const cap = needsGraph ? "graph" : "wiki";
    const capable = (S.kbs || []).filter(k => (k.capability_flags || {})[cap]);
    if (!capable.length) {
      return `当前可见的知识库里没有开启${cap === "graph" ? "知识图谱" : "Wiki"}的，` +
        "可在「资料解析」页新建一个（勾选对应能力）并上传资料。";
    }
    return `这不是工具坏了：当前范围里没有开启${cap === "graph" ? "知识图谱" : "Wiki"}的库。` +
      `已开启的有：${capable.map(k => k.name).join("、")}（在「填入示例」里会自动切到它）。`;
  }

  async function exampleNewestDoc(kbId) {
    if (EX.kbId === kbId && EX.docId) return EX;
    const r = await api("/api/tool", {
      method: "POST", json: { name: "list_documents", arguments: { knowledge_base_id: kbId, page_size: 5 } },
      headers: materialsHeaders(), brief: "取示例文档",
    });
    const docs = ((r.data && r.data.result) || {}).documents || [];
    const picked = docs.find(d => d.parse_status === "completed") || docs[0];
    if (picked) {
      EX.kbId = kbId;
      EX.docId = picked.id;
      EX.docTitle = picked.title || picked.file_name || "";
      // 用标题里的一个词做检索示例，比固定词更容易命中：优先取"-/_/. "分隔出的
      // 最长片段（"WeKnora-PDF验收样本" → "WeKnora"），否则截前 8 个字。
      const base = String(EX.docTitle).replace(/\.[a-z0-9]+$/i, "");
      const parts = base.split(/[\s\-_\.]+/).filter(t => t.length >= 2);
      const longest = parts.sort((a, b) => b.length - a.length)[0] || "";
      EX.docWord = (longest || base).slice(0, 12);
    }
    return EX;
  }

  function wikiExampleKb() {
    const kb = exampleKbFor("wiki");
    if (!kb) {
      throw new Error("当前可见的知识库里没有开启 Wiki 的；可在「资料解析」页新建一个" +
        "（勾选「同时生成 Wiki 页面」）并上传资料，等解析完成后再试");
    }
    return kb;
  }

  function examplePlainText() {
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    return "# 控制台演示文档\n\n这是 " + stamp + " 由控制台通过 MCP add_document 创建的演示内容。\n";
  }

  // resolveToolExample 返回 { args, note }：参数全部来自当前真实状态。
  async function resolveToolExample(name) {
    const kbId = exampleKbId();
    const kbArgs = { knowledge_base_id: kbId };
    const kbList = { knowledge_base_ids: kbId ? [kbId] : [] };
    switch (name) {
      case "list_knowledge_bases":
      case "list_parser_engines":
        return { args: {} };
      case "create_knowledge_base":
        return { args: { name: "演示知识库-" + new Date().toISOString().slice(0, 10),
                         description: "由控制台通过 MCP 创建", enable_wiki: false, enable_graph: false },
                 note: "创建成功后新的库会自动加入本端点范围，可以在「资料解析」页直接用它上传。" };
      case "list_documents":
        return { args: Object.assign({ page_size: 5 }, kbArgs) };
      case "get_knowledge_base_status":
        return { args: Object.assign({}, kbArgs) };
      case "get_document_status":
      case "read_document": {
        await exampleNewestDoc(kbId);
        if (!EX.docId) throw new Error("目标知识库里还没有文档，先上传一份");
        const args = { knowledge_id: EX.docId };
        if (name === "read_document") args.limit = 1;
        return { args, note: "用的是《" + (EX.docTitle || EX.docId) + "》" };
      }
      case "search_knowledge":
        await exampleNewestDoc(kbId);
        return { args: Object.assign({ query: EX.docWord || "验收", limit: 5 }, kbList),
                 note: "检索词「" + (EX.docWord || "验收") + "」取自最近文档的标题" };
      case "grep_chunks":
        await exampleNewestDoc(kbId);
        return { args: Object.assign({ query: EX.docWord || "验收", limit: 5 }, kbList) };
      case "ask":
        return { args: { question: "这个知识库里有哪些资料？请按文档分别说明。", mode: "quick-answer" } };
      case "wiki_index": {
        const kb = wikiExampleKb();
        return { args: Object.assign({ limit: 20 }, { knowledge_base_id: kb.id }),
                 note: `用的是《${kb.name}》（已开启 Wiki）` };
      }
      case "wiki_list_pages": {
        const kb = wikiExampleKb();
        return { args: Object.assign({ page: 1, page_size: 5 }, { knowledge_base_id: kb.id }),
                 note: `用的是《${kb.name}》（已开启 Wiki）` };
      }
      case "wiki_read_page": {
        const kb = wikiExampleKb();
        return { args: { slug: "index", knowledge_base_id: kb.id },
                 note: `《${kb.name}》的入口页；读别的页面先跑 wiki_index 拿 slug` };
      }
      case "wiki_search": {
        const kb = wikiExampleKb();
        return { args: Object.assign({ query: EX.docWord || "总结", limit: 5 },
                                     { knowledge_base_ids: [kb.id] }),
                 note: `在《${kb.name}》的 Wiki 里检索` };
      }
      case "wiki_graph": {
        const kb = wikiExampleKb();
        return { args: Object.assign({ limit: 10 }, { knowledge_base_id: kb.id }),
                 note: `《${kb.name}》的 Wiki 页面关系边` };
      }
      case "query_knowledge_graph": {
        const kb = exampleKbFor("graph");
        if (!kb) {
          throw new Error("当前可见的知识库里没有开启知识图谱的；可在「资料解析」页新建一个" +
            "（勾选「同时抽取知识图谱」）并上传资料，等解析完成后再试");
        }
        await exampleNewestDoc(kb.id);
        return { args: Object.assign({ query: EX.docWord || "项目" }, { knowledge_base_ids: [kb.id] }),
                 note: `用的是《${kb.name}》（已开启图谱）；刚导入的资料要等解析+抽取完成才有关系` };
      }
      case "upload_file":
        return { args: { knowledge_base_id: kbId, file_name: "console-demo-" + Date.now() + ".md",
                         content: exampleBase64() },
                 note: "示例把一段 Markdown 文本当作文件上传；返回的 upload_id 可以接着跑 import_document_file" };
      case "import_document_file": {
        const uploadId = (M.receipt && M.receipt.upload_id) || "";
        if (!uploadId) throw new Error("先在「资料解析」页上传一次，示例会复用那次 upload_id");
        return { args: { knowledge_base_id: kbId, upload_id: uploadId } };
      }
      case "get_upload_status": {
        const uploadId = (M.receipt && M.receipt.upload_id) || "";
        if (!uploadId) throw new Error("先上传一次，示例会复用那次 upload_id");
        return { args: { upload_id: uploadId } };
      }
      case "add_document":
        return { args: { knowledge_base_id: kbId, title: "控制台演示文档 " + new Date().toLocaleTimeString(),
                         content: examplePlainText() } };
      case "update_document": {
        await exampleNewestDoc(kbId);
        if (!EX.docId) throw new Error("目标知识库里还没有文档");
        return { args: { knowledge_id: EX.docId, content: examplePlainText() + "\n（由控制台更新）\n" },
                 note: "会覆盖《" + (EX.docTitle || EX.docId) + "》的正文，仅对 Markdown 文档有效" };
      }
      case "delete_document": {
        await exampleNewestDoc(kbId);
        if (!EX.docId) throw new Error("目标知识库里还没有文档");
        return { args: { knowledge_id: EX.docId },
                 note: "⚠️ 会把《" + (EX.docTitle || EX.docId) + "》删掉且不可撤销；演示前建议先用 add_document 建一篇草稿" };
      }
      default:
        return { args: {} };
    }
  }

  // exampleBase64 把演示文本编码成 upload_file 需要的 base64（UTF-8 安全）。
  function exampleBase64() {
    const text = examplePlainText();
    return btoa(unescape(encodeURIComponent(text)));
  }

  async function fillToolExample(section, box) {
    const note = box.querySelector("#b-example-note");
    const t = B.tool;
    if (!t) return;
    note.classList.remove("err");
    note.textContent = "正在准备示例参数…";
    let resolved;
    try {
      resolved = await resolveToolExample(t.name);
    } catch (e) {
      note.classList.add("err");
      note.textContent = e.message;
      return;
    }
    const args = resolved.args || {};
    if (B.formMode === "json") {
      box.querySelector("#b-json-text").value = JSON.stringify(args, null, 2);
    } else {
      for (const [name, entry] of Object.entries(B.formInputs)) {
        const el = entry.el, spec = entry.spec;
        if (!(name in args)) { el.checked = false; el.value = ""; continue; }
        const v = args[name];
        if (spec.type === "boolean") el.checked = !!v;
        else if (spec.type === "array") el.value = Array.isArray(v) ? v.join("\n") : String(v);
        else if (spec.type === "object") el.value = JSON.stringify(v, null, 2);
        else el.value = v == null ? "" : String(v);
      }
    }
    note.textContent = (resolved.note ? resolved.note + " " : "") +
      (TOOL_EXAMPLE_NOTE[t.name] || "示例参数已按当前真实数据填好");
  }

  async function runBenchTool(section, box) {
    const epoch = captureIdentityEpoch();
    const t = B.tool;
    const [cn] = toolCN(t.name);
    let args;
    if (B.formMode === "json") {
      try { args = JSON.parse(box.querySelector("#b-json-text").value || "{}"); }
      catch (e) { toast("JSON 解析失败：" + e.message, "err"); return; }
    } else {
      args = readForm();
    }
    if (t.destructive) {
      const okGo = await confirmDialog({
        title: `运行「${cn}」`, danger: true, confirmText: "运行",
        message: `这个工具会修改 WeKnora 里的数据（${t.name}）。\n\n参数：\n${JSON.stringify(args, null, 2).slice(0, 800)}`,
      });
      if (!okGo) return;
    }
    const st = box.querySelector("#b-status");
    st.classList.remove("err");
    st.textContent = `运行中…（${cn}）`;
    const r = await api("/api/tool", { method: "POST", json: { name: t.name, arguments: args }, brief: cn });
    if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
    const d = r.data || {};
    st.textContent = d.ok ? `成功 · 耗时 ${d.latency_ms}ms`
                          : `失败：${d.error || r.error || statusCN(r.status)}${d.error_code ? `（${d.error_code}）` : ""}`;
    if (!d.ok) {
      st.classList.add("err");
      const hint = capabilityHint(t.name, `${d.error_code || ""} ${d.error || ""}`);
      if (hint) st.textContent += " —— " + hint;
    }
    const pane = box.querySelector("#b-result");
    pane.innerHTML = "";
    const mk = (title, obj) => {
      const wrap = document.createElement("div");
      const h = document.createElement("h4"); h.textContent = title;
      const pre = document.createElement("pre"); pre.className = "raw";
      pre.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
      wrap.append(h, pre);
      return wrap;
    };
    pane.append(mk("请求（tools/call）", { name: t.name, arguments: args }));
    pane.append(mk("响应", d.result !== undefined ? d.result : { error: d.error, error_code: d.error_code }));
  }

  /* ===================== 调度 ===================== */
  const Views = {
    mounted: {},
    onIdentityChanged() {
      Object.assign(M, { file: null, channel: "tool", receipt: null, doc: null, steps: [], summary: null,
                            mounted: false, preview: null, lastStatus: null, idemAuto: true });
      docPollSeq++;  // 旧身份的轮询循环立即失效
      Object.assign(Q, { sessionId: "", busy: false, mounted: false });
      Object.assign(B, { tool: null, mounted: false });
      for (const name of ["materials", "qa", "bench"]) document.getElementById("view-" + name).innerHTML = "";
      this.show(S.ui.view, document.getElementById("view-" + S.ui.view));
    },
    show(name, section) {
      if (name === "materials" && !M.mounted) materialsMount(section);
      if (name === "qa" && !Q.mounted) qaMount(section);
      if (name === "bench" && !B.mounted) benchMount(section);
      if (name === "bench" && B.mounted) renderToolList(section, "");
      if (name === "materials") { syncKbSelect(section); syncEngineSelect(section); }
      if (name === "qa") { qaScopeChips(section); renderQaScopeLine(section); updateQaSendState(section); }
    },
    onSelectionChanged() {
      if (M.mounted) {
        const materials = document.getElementById("view-materials");
        syncKbSelect(materials);
        syncEngineSelect(materials);
      }
      if (Q.mounted) {
        const qa = document.getElementById("view-qa");
        qaScopeChips(qa);
        renderQaScopeLine(qa);
        updateQaSendState(qa);
      }
      if (B.mounted) renderToolList(document.getElementById("view-bench"), "");
    },
    // resetQaScopeState: 问答范围/模式变化时开启新会话的视图侧动作。
    resetQaScopeState() {
      Q.sessionId = "";
      Q.busy = false;
      const qa = document.getElementById("view-qa");
      if (qa) {
        const label = qa.querySelector("#qa-session");
        if (label) label.textContent = "–";
        const msgs = qa.querySelector("#qa-msgs");
        if (msgs) msgs.innerHTML = '<div class="empty">已按新的问答范围开启新会话。</div>';
        updateQaSendState(qa);
      }
      return true;
    },
  };
  window.Views = Views;
})();
