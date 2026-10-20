/* MCP 验证控制台 — 三视图：资料与解析验证 / 问答 / MCP 工具台 */
"use strict";

(function () {
  const { S, api, sse, toast, confirmDialog, renderMarkdown, escapeHtml, mcpHeaders,
          captureIdentityEpoch, isCurrentIdentityEpoch, toolCN, fieldCN, statusCN } = window.App;

  /* ===================== 视图一：资料与解析验证 ===================== */
  const M = {
    file: null, receipt: null, doc: null,
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
        <h3><span class="step-no">1</span>选择资料</h3>
        <div class="sub">文件上传到「目标知识库」——本次导入与状态查询只作用于它。上传与导入由一次
        MCP <span class="mono">ingest_document.submit</span> 完成（字节随请求 base64 发送）；解析方式在下一步选择。</div>
        <div class="row">
          <label class="field grow"><span>目标知识库（本次上传目标）</span>
            <select id="m-kb" class="input"></select></label>
          <button id="m-kb-new" class="btn ghost small" title="经 MCP knowledge_base.create 新建">＋ 新建知识库</button>
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
        <div class="sub">选项来自 <span class="mono">knowledge_base.get</span> 返回的解析引擎目录。默认沿用知识库配置；
        若与既有文档内容相同被去重，会复用旧解析结果，本次选项不会重新应用。</div>
        <div class="row">
          <label class="field grow"><span>解析引擎</span><select id="m-engine" class="input"></select></label>
        </div>
        <div class="row"><span id="m-engine-note" class="kv"></span></div>
      </div>

      <div class="card">
        <h3><span class="step-no">3</span>上传并解析</h3>
        <div class="sub">一次提交由 WeKnora 完成上传、导入、解析与索引。下面会实时显示各阶段进度、请求与实际使用的引擎，解析完成后给出分块数与原文预览。</div>
        <div class="row">
          <button id="m-ingest" class="btn">上传并导入</button>
          <span class="kv">document：<b id="m-doc" class="mono">–</b></span>
          <span class="grow"></span>
          <button id="m-recent" class="btn ghost small">查看知识库最近导入</button>
        </div>
        <div class="row"><span id="m-import-status" class="status-line"></span></div>
        <div id="m-doc-status"></div>
        <div id="m-recent-list"></div>
      </div>
    `;

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

    // --- 上传并导入（一次 ingest_document.submit）---
    section.querySelector("#m-ingest").onclick = async () => {
      const epoch = captureIdentityEpoch();
      const st = section.querySelector("#m-import-status");
      const kb = section.querySelector("#m-kb").value;
      if (!window.App.activeProfile()) { toast("请先配置有效 Token", "err"); return; }
      if (!kb) { st.textContent = "请选择目标知识库"; st.classList.add("err"); return; }
      if (!M.file) { st.textContent = "请选择文件"; st.classList.add("err"); return; }
      st.classList.remove("err");
      // 解析方式随 submit 的 process_config 一起提交：只对本次导入生效。
      let processConfig = null;
      const engine = section.querySelector("#m-engine").value;
      if (engine && engine !== "__default__") {
        const ext = (String(M.file.name || "").split(".").pop() || "pdf").toLowerCase();
        processConfig = { parser_engine_rules: [{ file_types: [ext], engine }] };
      }
      // 最多两次：上传标识冲突时自动换一个新的标识重试一次（同一标识配不同
      // 字节/知识库会被服务端按幂等契约拒绝，换文件本就不该沿用旧标识）。
      for (let attempt = 1; attempt <= 2; attempt++) {
        const idem = section.querySelector("#m-idem").value.trim();
        st.textContent = "上传并导入中（ingest_document.submit）…";
        const fd = new FormData();
        fd.append("knowledge_base_id", kb);
        fd.append("file", M.file, M.file.name);
        if (processConfig) fd.append("process_config", JSON.stringify(processConfig));
        const headers = Object.assign(materialsHeaders(), idem ? { "Idempotency-Key": idem } : {});
        const r = await api("/api/ingest", {
          method: "POST", body: fd, headers,
          brief: `上传并导入 ${M.file.name}`,
        });
        if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
        const d = r.data || {};
        const res = d.result || null;
        if (r.ok && d.ok && res && res.ingest_id) {
          M.receipt = Object.assign({ kb }, res);
          M.doc = { id: res.document_id || "", title: res.file_name || M.file.name };
          M.docStartedAt = Date.now();
          M.preview = null;
          section.querySelector("#m-doc").textContent = M.doc.id || "–";
          const applied = res.process_config_applied;
          st.textContent = `已提交（stage=${res.stage || "queued"} queued=${res.queued} dedup=${res.deduplicated}` +
            (applied === undefined ? "" : ` · 解析选项${applied ? "已提交" : "未重新应用"}`) + "）";
          if (res.note && applied === false) st.textContent += " — " + res.note;
          renderReceipt(section);
          saveLastImport();
          pollIngest(section);
          return;
        }
        if (attempt === 1 && M.idemAuto && isIdempotencyConflict(d, r)) {
          newIdem(section);
          st.textContent = "这个上传标识已用于另一份文件，已自动换新标识并重试…";
          continue;
        }
        st.textContent = "上传并导入失败：" + uploadErrorText(d, r);
        st.classList.add("err");
        return;
      }
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
      sub.textContent = "经 MCP knowledge_base.create 创建：语义检索与关键词检索默认开启，Wiki / 图谱按需勾选。";
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
      const mkHinted = (label, value, placeholder, id, tag) => {
        const lab = document.createElement("label");
        lab.className = "field";
        lab.innerHTML = `<span>${escapeHtml(label)}</span>`;
        // 关系是多行文本：必须用 textarea，单行 input 会把换行吞掉。
        const input = document.createElement(tag || "input");
        input.className = "input wide";
        if (tag === "textarea") input.rows = 4;
        input.id = id;
        input.value = value;
        input.placeholder = placeholder;
        lab.appendChild(input);
        box.appendChild(lab);
        return { lab, input };
      };
      // 只开图谱开关、不给实体/关系，抽取管线跑了也抽不出任何关系 ——
      // 这正是「图谱查询报未配置」的常见原因，所以这里预填一套可直接用的例子。
      const entityField = mkHinted("图谱实体类型（逗号分隔）", "人员,项目,服务,批次",
        "例如：人员,项目,服务", "kb-new-entities");
      const relationField = mkHinted("图谱关系（每行一条：起点,终点,关系）",
        ["人员,项目,负责", "人员,项目,复核", "项目,服务,依赖", "批次,项目,属于"].join("\n"),
        "例如：人员,项目,负责", "kb-new-relations", "textarea");
      const syncGraphFields = () => {
        for (const f of [entityField, relationField]) {
          f.lab.classList.toggle("hidden", !graphToggle.checked);
        }
      };
      graphToggle.onchange = syncGraphFields;
      syncGraphFields();

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
        const createArgs = {
          name,
          description: descInput.value.trim(),
          enable_wiki: wikiToggle.checked,
          enable_graph: graphToggle.checked,
        };
        if (graphToggle.checked) {
          const entities = entityField.input.value.split(/[,\n，]/).map(t => t.trim()).filter(Boolean);
          const relations = relationField.input.value.split(/\n/).map(t => t.trim()).filter(Boolean);
          if (!entities.length && !relations.length) {
            toast("勾了知识图谱，但没填实体/关系：这样抽不出任何关系，请至少填一项", "err");
            return;
          }
          createArgs.graph_entities = entities;
          createArgs.graph_relations = relations;
        }
        const epoch = captureIdentityEpoch();
        ok.disabled = true;
        ok.textContent = "创建中…";
        const r = await api("/api/tool", {
          method: "POST",
          json: { name: "knowledge_base", arguments: Object.assign({ action: "create" }, createArgs) },
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
        : "解析引擎目录不可用：knowledge_base.get 未返回解析器目录，将使用知识库默认";
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
    section.querySelector("#m-ingest").disabled = false;
    const st = section.querySelector("#m-import-status");
    st.textContent = "已恢复上次导入记录（刷新前提交的内容），下面显示它当前的状态";
    if ((M.receipt && M.receipt.ingest_id) || (M.doc && M.doc.id)) {
      section.querySelector("#m-doc").textContent = (M.doc && M.doc.id) || "–";
      pollIngest(section);
    }
  }

  const STATUS_CN = {
    pending: "排队中", queued: "排队中", running: "解析中", parsing: "解析中", processing: "解析中",
    indexing: "索引中", finalizing: "收尾中", summarizing: "生成摘要中",
    completed: "已完成", success: "已完成", failed: "失败", cancelled: "已取消",
    disabled: "已停用", empty: "无", unknown: "未知",
    staged: "已暂存", imported: "已导入", expired: "已过期",
  };
  function parseStatusCN(s) {
    const key = String(s || "").toLowerCase();
    return STATUS_CN[key] || (s ? String(s) : "未知");
  }
  function doneStatus(s) { return ["completed", "failed", "cancelled"].includes(String(s || "").toLowerCase()); }

  // docPollSeq：新的轮询或新的文档会让旧的循环立刻退出，避免两个循环互相覆盖。
  let docPollSeq = 0;

  // pollIngest 轮询 ingest_document.status：上传/解析/索引分阶段回报，
  // 并回显 requested / applied 引擎。提交后即可见。
  async function pollIngest(section) {
    const box = section.querySelector("#m-doc-status");
    const ingestId = M.receipt && M.receipt.ingest_id;
    const docId = M.doc && M.doc.id;
    if (!box || (!ingestId && !docId)) return;
    const seq = ++docPollSeq;
    const epoch = captureIdentityEpoch();
    // 有原始导入时间就接着它算等待时长（刷新后不清零）。
    const startedAt = M.docStartedAt || Date.now();
    M.docStartedAt = startedAt;
    let preview = M.preview && M.preview.id === docId ? M.preview : null;
    const query = new URLSearchParams();
    if (ingestId) query.set("ingest_id", ingestId);
    if (docId) query.set("document_id", docId);
    for (let i = 0; i < 100; i++) {
      const r = await api(`/api/ingest_status?${query}`,
        { headers: materialsHeaders(), brief: getDocTitle() });
      if (!isCurrentIdentityEpoch(epoch) || r.stale || seq !== docPollSeq) return;
      const data = r.data || {};
      const result = data.result || {};
      const phases = result.phases || {};
      const status = result.document || {};
      const done = doneStatus(phases.parse);
      if (done && !preview) {
        preview = await readDocPreview(section, docId, epoch, seq);
        M.preview = preview ? Object.assign({ id: docId }, preview) : null;
      }
      if (seq !== docPollSeq) return;
      M.lastPhases = phases;
      renderDocProgress(section, status, {
        elapsed: Math.round((Date.now() - startedAt) / 1000),
        preview, done, timedOut: false, phases,
      });
      if (done) return;
      await new Promise(res => setTimeout(res, i < 5 ? 1500 : 3000));
    }
    if (seq !== docPollSeq) return;
    const last = M.lastStatus || {};
    renderDocProgress(section, last, { elapsed: 300, preview, done: false,
                                       timedOut: true, phases: M.lastPhases || {} });
  }

  function getDocTitle() {
    return (M.doc && M.doc.title) || (M.receipt && M.receipt.file_name) || "ingest status";
  }

  // readDocPreview 读回解析结果的头一段：分块数 + 原文前 200 字，
  // 让人一眼看出「解析出什么了」（扫描件没开 OCR 时会明显为空）。
  async function readDocPreview(section, docId, epoch, seq) {
    const r = await api("/api/tool", {
      method: "POST",
      json: { name: "read_document", arguments: { action: "read", knowledge_id: docId, limit: 1 } },
      headers: materialsHeaders(), brief: "读取解析结果",
    });
    if (!isCurrentIdentityEpoch(epoch) || r.stale || seq !== docPollSeq) return null;
    if (!r.ok || !(r.data && r.data.ok)) return { total: null, text: "", error: (r.data && r.data.error) || r.error };
    const d = ((r.data.result) || {}).document || {};
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
    const phases = ctx.phases || {};
    const cells = [
      ["上传", parseStatusCN(phases.upload || "unknown")],
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
    box.querySelector("#m-status-refresh").onclick = () => pollIngest(section);
    box.querySelector("#m-status-forget").onclick = () => {
      docPollSeq++;              // 让在飞的轮询循环退出
      clearLastImport();
      M.receipt = null; M.doc = null; M.preview = null; M.lastPhases = null;
      section.querySelector("#m-receipt").innerHTML = "";
      section.querySelector("#m-doc").textContent = "–";
      section.querySelector("#m-import-status").textContent = "";
      section.querySelector("#m-doc-status").innerHTML = "";
      section.querySelector("#m-ingest").disabled = true;
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
      json: { name: "read_document",
              arguments: { action: "list", knowledge_base_id: kb, page_size: 8 } },
      headers: materialsHeaders(), brief: "列出最近导入",
    });
    if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
    const block = ((r.data && r.data.result) || {}).documents || {};
    const docs = block.documents || [];
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
        pollIngest(section);
      };
    });
  }


  function renderReceipt(section) {
    const box = section.querySelector("#m-receipt");
    const r = M.receipt;
    if (!r) { box.innerHTML = ""; return; }
    box.innerHTML = `
      <div class="receipt">
        <div class="kv">ingest_id <b class="mono">${escapeHtml(r.ingest_id || "")}</b> ·
        upload_id <b class="mono">${escapeHtml(r.upload_id || "")}</b> ·
        stage <b>${escapeHtml(r.stage || "–")}</b></div>
        <div class="kv">file <b>${escapeHtml(r.file_name || "")}</b> · size <b>${r.file_size ?? "?"}</b>
        ${r.deduplicated ? "· <b>dedup=true</b>（同内容复用旧解析）" : ""}</div>
      </div>`;
  }

  async function runChecklist(section) {
    const epoch = captureIdentityEpoch();
    const kb = (M.receipt && M.receipt.kb) || S.uploadTargetKbId ||
      (section.querySelector("#m-kb") ? section.querySelector("#m-kb").value : "");
    if (!kb) { toast("请选择目标知识库", "err"); return; }
    if (!window.App.activeProfile()) { toast("请先配置有效 Token", "err"); return; }
    const body = { knowledge_base_id: kb };
    if (M.doc && M.doc.id) body.document_id = M.doc.id;
    if (M.receipt && M.receipt.ingest_id) body.ingest_id = M.receipt.ingest_id;
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
          if (evt.tool === "ingest_document.status") {
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

  /* ===================== 视图二：知识库文档管理 ===================== */
  // 全部读写都走五工具核心：read_document.list 出目录，read_document.read
  // 出正文（query 即文档内字面检索）。页面只做展示，不缓存跨身份的文档。
  const D = {
    mounted: false, kbId: "", loadedKb: "", docs: [], total: 0, page: 1, pageSize: 10,
    selectedId: "", selected: null, doc: null, chunks: [], totalChunks: 0,
    fetched: 0, offset: 0, limit: 8, query: "", matchCount: null,
    truncated: false, nextOffset: null, loading: false, readLoading: false,
    error: "", readError: "", reqSeq: 0, readSeq: 0,
  };

  function docPageCount() {
    return Math.max(1, Math.ceil(D.total / D.pageSize));
  }

  function docStatusBadge(status) {
    const key = String(status || "").toLowerCase();
    const cls = ["completed", "success"].includes(key) ? "ok"
      : ["failed", "cancelled"].includes(key) ? "err"
      : key ? "warn" : "gray";
    return `<span class="badge ${cls}">${escapeHtml(parseStatusCN(status))}</span>`;
  }

  function docsMount(section) {
    section.innerHTML = `
      <div class="card">
        <h3>知识库文档 <span class="badge ok">MCP 只读</span></h3>
        <div class="sub">浏览已入库文档、核对解析状态、读回分块原文。目录来自
          <span class="mono">read_document.list</span>，正文与文档内检索来自
          <span class="mono">read_document.read</span>；每次读取都由 WeKnora 按当前身份重新授权。</div>
        <div class="row">
          <label class="field grow"><span>知识库</span><select id="d-kb" class="input"></select></label>
          <label class="field"><span>每页</span>
            <select id="d-page-size" class="input">
              <option value="10">10 篇</option>
              <option value="20">20 篇</option>
              <option value="50">50 篇</option>
            </select></label>
          <span class="grow"></span>
          <button id="d-refresh" class="btn ghost small">刷新</button>
        </div>
        <div class="row"><span id="d-summary" class="kv">配置 Token 后加载文档。</span></div>
      </div>
      <div class="docs">
        <div class="card">
          <h3>文档目录</h3>
          <input id="d-filter" class="input wide" placeholder="在当前页按标题 / 文件名过滤…">
          <div id="d-list" class="doc-list" style="margin-top:10px"></div>
          <div class="docs-pager">
            <button id="d-prev" class="btn ghost small" disabled>上一页</button>
            <span id="d-page" class="kv"></span>
            <button id="d-next" class="btn ghost small" disabled>下一页</button>
          </div>
        </div>
        <div class="card doc-reader-card">
          <div id="d-reader"><div class="empty">从左侧选择一篇文档，这里会显示解析状态与分块原文。</div></div>
        </div>
      </div>`;

    const size = section.querySelector("#d-page-size");
    if (size) size.value = String(D.pageSize);
    section.querySelector("#d-kb").onchange = e => {
      D.kbId = e.target.value;
      D.page = 1; D.selectedId = ""; D.selected = null; D.doc = null;
      D.chunks = []; D.query = ""; D.error = ""; D.readError = "";
      D.reqSeq++; D.readSeq++;
      renderDocReader(section);
      loadDocs(section);
    };
    section.querySelector("#d-page-size").onchange = e => {
      D.pageSize = Number(e.target.value) || 10; D.page = 1;
      loadDocs(section, { keepSelection: true });
    };
    section.querySelector("#d-refresh").onclick = () => {
      D.error = "";
      loadDocs(section, { keepSelection: true });
    };
    section.querySelector("#d-filter").oninput = () => renderDocRows(section);
    section.querySelector("#d-prev").onclick = () => {
      if (D.page <= 1) return;
      D.page -= 1; loadDocs(section, { keepSelection: true });
    };
    section.querySelector("#d-next").onclick = () => {
      if (D.page >= docPageCount()) return;
      D.page += 1; loadDocs(section, { keepSelection: true });
    };
    D.mounted = true;
    syncDocsKb(section);
  }

  // syncDocsKb 把顶栏已加载的知识库同步到本页下拉框；选中的库不可见时
  // 回退到资料页目标库或第一个可见库，并只在库真正变化时重新拉目录。
  function syncDocsKb(section) {
    const sel = section.querySelector("#d-kb");
    if (!sel) return;
    const valid = new Set((S.kbs || []).map(k => k.id));
    let next = D.kbId;
    if (!next || !valid.has(next)) {
      next = (S.uploadTargetKbId && valid.has(S.uploadTargetKbId))
        ? S.uploadTargetKbId : ((S.kbs[0] && S.kbs[0].id) || "");
    }
    const changed = next !== D.kbId;
    D.kbId = next;
    sel.innerHTML = "";
    if (!S.kbs.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = window.App.activeProfile() ? "没有可见的知识库" : "配置 Token 后加载";
      sel.appendChild(o);
    } else {
      for (const kb of S.kbs) {
        const o = document.createElement("option");
        o.value = kb.id;
        const typeCN = { document: "文档库", faq: "FAQ 库" }[kb.type] || kb.type;
        o.textContent = typeCN ? `${kb.name} · ${typeCN}` : kb.name;
        sel.appendChild(o);
      }
    }
    sel.value = D.kbId;
    if (changed) {
      D.page = 1; D.selectedId = ""; D.selected = null; D.doc = null;
      D.chunks = []; D.query = ""; D.error = ""; D.readError = "";
      D.reqSeq++; D.readSeq++;
      renderDocReader(section);
    }
    if (D.kbId && D.loadedKb !== D.kbId) loadDocs(section);
    else if (!D.kbId) {
      D.docs = []; D.total = 0; D.loadedKb = "";
      renderDocRows(section); renderDocReader(section);
    }
  }

  async function loadDocs(section, opts = {}) {
    if (!D.kbId) { renderDocRows(section); return; }
    const epoch = captureIdentityEpoch();
    const seq = ++D.reqSeq;
    D.loading = true;
    D.error = "";
    D.loadedKb = D.kbId;
    updateDocSummary(section);
    updateDocPager(section);
    const box = section.querySelector("#d-list");
    if (box) box.innerHTML = '<div class="kv">正在读取文档目录…</div>';
    const qs = new URLSearchParams({ knowledge_base_id: D.kbId,
      page: String(D.page), page_size: String(D.pageSize) });
    const r = await api(`/api/documents?${qs}`, {
      headers: materialsHeaders(), brief: "read_document.list",
    });
    if (!isCurrentIdentityEpoch(epoch) || r.stale || seq !== D.reqSeq) return;
    D.loading = false;
    const d = r.data || {};
    if (!r.ok || !d.ok) {
      D.docs = []; D.total = 0;
      D.error = String(d.error || r.error || statusCN(r.status));
      renderDocRows(section); renderDocReader(section);
      return;
    }
    D.docs = Array.isArray(d.documents) ? d.documents : [];
    D.total = Number(d.total) || 0;
    D.page = Number(d.page) || D.page;
    if (D.page > docPageCount()) { D.page = docPageCount(); return loadDocs(section, opts); }
    D.selected = D.selectedId ? (D.docs.find(x => x.id === D.selectedId) || D.selected) : null;
    if (D.selectedId && !D.docs.some(x => x.id === D.selectedId)) {
      // 翻页后选中的文档不在本页：保留阅读器，目录里不再高亮即可。
      D.selected = D.selected || { title: D.selectedId };
    }
    renderDocRows(section);
    if (!D.selectedId) {
      const first = D.docs.find(x => x.parse_status === "completed") || D.docs[0];
      if (first) openDoc(section, first);
      else renderDocReader(section);
    } else {
      renderDocReader(section);
    }
  }

  function openDoc(section, doc) {
    D.selectedId = doc.id;
    D.selected = doc;
    D.doc = null;
    D.chunks = [];
    D.totalChunks = 0;
    D.fetched = 0;
    D.offset = 0;
    D.query = "";
    D.matchCount = null;
    D.truncated = false;
    D.nextOffset = null;
    D.readError = "";
    renderDocRows(section);
    renderDocReader(section, { loading: true });
    loadDocument(section, { offset: 0, query: "" });
  }

  async function loadDocument(section, opts = {}) {
    if (!D.selectedId) return;
    const epoch = captureIdentityEpoch();
    const seq = ++D.readSeq;
    const offset = Math.max(0, Number(opts.offset) || 0);
    const query = opts.query === undefined ? D.query : String(opts.query || "").trim();
    D.offset = offset;
    D.query = query;
    D.readLoading = true;
    D.readError = "";
    renderDocReader(section, { loading: !D.doc });
    const qs = new URLSearchParams({ knowledge_id: D.selectedId,
      offset: String(offset), limit: String(D.limit) });
    if (query) qs.set("query", query);
    const r = await api(`/api/document?${qs}`, {
      headers: materialsHeaders(),
      brief: query ? "read_document.read（文档内检索）" : "read_document.read",
    });
    if (!isCurrentIdentityEpoch(epoch) || r.stale || seq !== D.readSeq) return;
    D.readLoading = false;
    const d = r.data || {};
    if (!r.ok || !d.ok) {
      D.readError = String(d.error || r.error || statusCN(r.status));
      renderDocReader(section);
      return;
    }
    D.doc = d.document || {};
    D.chunks = Array.isArray(d.chunks) ? d.chunks : [];
    D.totalChunks = Number(d.total_chunks) || 0;
    D.fetched = Number(d.fetched_chunks) || D.chunks.length;
    D.offset = Number(d.offset) || offset;
    D.query = d.query || query;
    D.matchCount = d.match_count;
    D.truncated = !!d.truncated;
    D.nextOffset = d.next_offset == null ? null : Number(d.next_offset);
    renderDocReader(section);
  }

  function updateDocSummary(section) {
    const el = section.querySelector("#d-summary");
    if (!el) return;
    if (!D.kbId) {
      el.textContent = window.App.activeProfile() ? "没有可见的知识库。" : "配置 Token 后加载文档。";
      return;
    }
    const name = ((S.kbs || []).find(k => k.id === D.kbId) || {}).name || D.kbId;
    if (D.error) { el.textContent = `《${name}》读取失败：${D.error}`; return; }
    el.textContent = `《${name}》共 ${D.total} 篇 · 第 ${D.page}/${docPageCount()} 页` +
      (D.loading ? " · 加载中…" : "");
  }

  function updateDocPager(section) {
    const label = section.querySelector("#d-page");
    const prev = section.querySelector("#d-prev");
    const next = section.querySelector("#d-next");
    if (label) label.textContent = `第 ${D.page} / ${docPageCount()} 页`;
    if (prev) prev.disabled = D.page <= 1 || D.loading;
    if (next) next.disabled = D.page >= docPageCount() || D.loading;
  }

  function renderDocRows(section) {
    const box = section.querySelector("#d-list");
    if (!box) return;
    box.innerHTML = "";
    updateDocSummary(section);
    updateDocPager(section);
    if (!D.kbId) {
      box.innerHTML = '<div class="empty">选择一个知识库后查看文档。</div>';
      return;
    }
    if (D.error) {
      box.innerHTML = `<div class="empty err-text">读取失败：${escapeHtml(D.error)}</div>`;
      return;
    }
    if (!D.docs.length) {
      box.innerHTML = '<div class="empty">这个知识库还没有文档。到「资料与解析」上传第一份资料。</div>';
      return;
    }
    const filterEl = section.querySelector("#d-filter");
    const filter = ((filterEl && filterEl.value) || "").trim().toLowerCase();
    const rows = D.docs.filter(d => !filter ||
      `${d.title || ""} ${d.file_name || ""}`.toLowerCase().includes(filter));
    if (!rows.length) {
      box.innerHTML = '<div class="empty">本页没有匹配的文档，试试翻页或清空过滤。</div>';
      return;
    }
    // 用 DOM 节点建表：行点击直接绑定，也便于测试驱动真实 UI。
    const table = document.createElement("table");
    table.className = "tbl docs-tbl";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const h of ["文档", "状态", "更新时间"]) {
      const th = document.createElement("th");
      th.textContent = h;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const d of rows) {
      const tr = document.createElement("tr");
      tr.className = "doc-row" + (d.id === D.selectedId ? " on" : "");
      tr.dataset.docId = d.id;
      const titleCell = document.createElement("td");
      const title = escapeHtml(d.title || d.file_name || d.id);
      const kind = [...new Set([d.file_type, d.source].filter(Boolean))]
        .map(escapeHtml).join(" · ");
      titleCell.innerHTML = `<div class="doc-title">${title}</div>` +
        `<div class="doc-meta mono">${kind || escapeHtml(String(d.id).slice(0, 12))}</div>`;
      const statusCell = document.createElement("td");
      statusCell.innerHTML = docStatusBadge(d.parse_status);
      const dateCell = document.createElement("td");
      dateCell.className = "doc-date";
      dateCell.textContent = String(d.updated_at || d.created_at || "")
        .slice(0, 19).replace("T", " ");
      tr.append(titleCell, statusCell, dateCell);
      tr.onclick = () => openDoc(section, d);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
  }

  function docChunkHtml(c) {
    const idx = c.chunk_index != null ? c.chunk_index : c.seq;
    const roleText = { match: "命中", context_before: "上文", context_after: "下文", focus: "定位" }[c.role];
    const role = roleText ? `<span class="doc-role ${escapeHtml(c.role)}">${roleText}</span>` : "";
    const rawSnippet = String(c.match_snippet || "");
    const snippet = rawSnippet
      ? `<div class="dc-snippet">命中：${escapeHtml(rawSnippet.slice(0, 240))}${rawSnippet.length > 240 ? "…" : ""}</div>`
      : "";
    const faq = c.faq_question
      ? `<div class="dc-faq">Q：${escapeHtml(c.faq_question)}</div>` : "";
    const images = Array.isArray(c.images) && c.images.length
      ? `<div class="kv">含 ${c.images.length} 张图片</div>` : "";
    return `<article class="doc-chunk">
      <div class="dc-head"><span class="dc-index">#${escapeHtml(String(idx))}</span>
        <span class="mono">${escapeHtml(c.chunk_id || "")}</span>${role}</div>
      ${snippet}${faq}<div class="dc-body">${renderMarkdown(c.content || "")}</div>${images}</article>`;
  }

  function renderDocReader(section, opts = {}) {
    const box = section.querySelector("#d-reader");
    if (!box) return;
    if (!D.selectedId) {
      box.innerHTML = '<div class="empty">从左侧选择一篇文档，这里会显示解析状态与分块原文。</div>';
      return;
    }
    const info = D.doc || {};
    const summary = D.selected || {};
    const title = info.title || summary.title || summary.file_name || D.selectedId;
    const status = info.parse_status || summary.parse_status || "";
    const chunkCount = info.chunk_count != null ? info.chunk_count : D.totalChunks;
    const metaBits = [info.file_type || summary.file_type, info.source || summary.source,
      chunkCount ? `${chunkCount} 块` : null,
      info.file_size, info.description].filter(Boolean);
    const header = `
      <div class="doc-reader-head">
        <div><h3>${escapeHtml(title)}</h3>
          <div class="kv mono">${escapeHtml(D.selectedId)}</div></div>
        ${docStatusBadge(status)}
      </div>
      <div class="doc-meta-line">${metaBits.map(x =>
        `<span>${escapeHtml(String(x))}</span>`).join("")}</div>`;
    if (D.readError) {
      box.innerHTML = header + `<div class="empty err-text">读取正文失败：${escapeHtml(D.readError)}</div>
        <div class="row"><button id="d-read-retry" class="btn ghost small">重试</button></div>`;
      box.querySelector("#d-read-retry").onclick = () => loadDocument(section, { offset: D.offset });
      return;
    }
    if (opts.loading || (D.readLoading && !D.doc)) {
      box.innerHTML = header + '<div class="kv">读取正文中…</div>';
      return;
    }
    if (!D.doc) { box.innerHTML = header; return; }

    const searching = !!D.query;
    const chunksHtml = D.chunks.length
      ? D.chunks.map(docChunkHtml).join("")
      : (searching
        ? `<div class="empty">没有找到包含「${escapeHtml(D.query)}」的分块，换一个词试试。</div>`
        : (String(status).toLowerCase() === "completed"
          ? '<div class="empty">这篇文档没有可读分块（可能只包含图片，或解析结果为空）。</div>'
          : `<div class="empty">解析尚未完成（当前：${escapeHtml(parseStatusCN(status))}），暂时没有正文。到「资料与解析」页可继续看进度。</div>`));
    const range = searching
      ? (D.matchCount != null ? `命中 ${D.matchCount} 个分块` : `返回 ${D.chunks.length} 个分块`)
      : `第 ${D.totalChunks ? D.offset + 1 : 0}–${D.offset + D.chunks.length} 块 / 共 ${D.totalChunks} 块`;
    const canNext = D.truncated && D.nextOffset != null;
    box.innerHTML = header + `
      <div class="row doc-search">
        <input id="d-query" class="input grow" placeholder="在本文档内检索（字面匹配；多个词需全部命中）">
        <button id="d-query-run" class="btn ghost small">检索</button>
        <button id="d-query-clear" class="btn ghost small"${searching ? "" : " disabled"}>清除</button>
      </div>
      ${D.readLoading ? '<div class="status-line cursor">正在读取这一段…</div>' : ""}
      ${searching ? `<div class="kv">文档内检索「${escapeHtml(D.query)}」${D.truncated ? " · 结果已截断，可继续往后找" : ""}</div>` : ""}
      <div class="doc-chunks">${chunksHtml}</div>
      <div class="docs-pager">
        <button id="d-read-prev" class="btn ghost small"${D.offset > 0 ? "" : " disabled"}>${searching ? "从头找" : "上一组"}</button>
        <span class="kv">${range}</span>
        <button id="d-read-next" class="btn ghost small"${canNext ? "" : " disabled"}>${searching ? "继续往后找" : "下一组"}</button>
      </div>`;
    const input = box.querySelector("#d-query");
    if (input) {
      input.value = D.query;
      input.onkeydown = e => {
        if (e.key === "Enter") { e.preventDefault(); runDocQuery(section); }
      };
    }
    box.querySelector("#d-query-run").onclick = () => runDocQuery(section);
    box.querySelector("#d-query-clear").onclick = () => loadDocument(section, { offset: 0, query: "" });
    box.querySelector("#d-read-prev").onclick = () => {
      if (searching) loadDocument(section, { offset: 0 });
      else loadDocument(section, { offset: Math.max(0, D.offset - D.limit) });
    };
    box.querySelector("#d-read-next").onclick = () => {
      if (D.nextOffset == null) return;
      loadDocument(section, { offset: D.nextOffset });
    };
  }

  function runDocQuery(section) {
    // 读的是阅读器里实际渲染的输入框：同一 section 上再 querySelector 只会
    // 拿到另一个占位节点（测试 DOM 尤其明显），真实页面也会读错控件。
    const box = section.querySelector("#d-reader");
    const input = box ? box.querySelector("#d-query") : null;
    const q = input ? String(input.value || "").trim() : "";
    loadDocument(section, { offset: 0, query: q });
  }

  /* ===================== 视图三：问答 ===================== */
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
        <div class="sub" id="qa-hint">问答经五工具核心的 <span class="mono">ask</span> 提交（<span class="mono">/mcp/core/:id</span>），
        mode 由 WeKnora 校验生效；「端点默认」使用端点配置的问答档案（本控制台只走 WeKnora 自己的问答链，不再内置其他编排框架）。</div>
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
    if (name === "knowledge_base") return "知识库";
    if (name === "ingest_document") return "导入 / 状态";
    if (name === "search_knowledge") return "检索";
    if (name === "read_document") return "读取";
    if (name === "ask") return "问答";
    return "其他";
  }

  /* ---- 五工具的使用说明与自测步骤（诊断页展示，中文） ---- */
  const TOOL_USAGE = {
    knowledge_base: {
      purpose: "知识库目录与配置：列库、看单个库的能力与解析器目录、按需建库。其他工具的选库依据都在这里取得。",
      actions: [
        ["list", "列出当前身份可见的知识库，含 wiki / graph / vector / keyword 能力标记（真实可用性还要看 graph_ready）。"],
        ["get", "看一个库的详情：文档数/分块数、Wiki 与图谱的 available 状态、解析引擎目录、端点上已发布的问答档案。"],
        ["create", "新建知识库：默认开启向量 + 关键词；勾选 Wiki / 图谱时建议同时给出实体类型与关系（否则抽不出关系）。"],
      ],
      steps: [
        "运行 list，确认目标库在范围内，记下 knowledge_base_id（后续所有工具都要用它）。",
        "对目标库运行 get（include_capabilities=true）：应看到 status.status.documents / chunks，以及 parser_engines.engines 非空。",
        "如需新库再运行 create；创建成功后回到 list 确认新库已出现、并把「资料解析」页的上传目标切到它。",
      ],
      expect: "list 返回 knowledge_bases 非空；get 返回 status.status 计数与 parser_engines.engines；create 返回新库 id 与端点范围说明。",
      pitfalls: "create 是写操作会真的建库；受限端点上新库会自动加入本端点范围；get 依赖端点的状态与解析器目录权限，缺权限时会被拒绝并写明缺哪个许可。",
    },
    ingest_document: {
      purpose: "把文件送进知识库并跟踪处理：submit 一次完成「上传 + 导入 + 解析入队」，status 回报上传 / 解析 / 索引各阶段。",
      actions: [
        ["submit", "提交文件：file 用 base64 携带字节（{name, encoding:\"base64\", content}），可带 process_config 指定解析引擎，idempotency_key 标识一次上传操作。"],
        ["status", "按 ingest_id 或 document_id 查询阶段：phases.upload / parse / index，文档维度还带页数、分块数与错误信息。"],
      ],
      steps: [
        "submit：用「换一个示例」选到 submit 示例（会自动生成一段小 Markdown 与新的 idempotency_key），运行后记下 ingest_id 与 document_id。",
        "status：把示例切回 status（会自动带上刚提交的 ingest_id），反复运行直到 phases.parse=completed 且 phases.index=completed。",
        "用 read_document.read + 上面的 document_id 核对正文，确认内容真的进去了。",
      ],
      expect: "submit 返回 stage=queued、非空 ingest_id / document_id；status 的 phases.parse 与 phases.index 最终变为 completed。",
      pitfalls: "同内容重复提交会 deduplicated=true（复用旧解析结果，process_config 不再重新应用）；扫描件/大文件解析可能要几分钟；wiki、graph 在单文档维度固定为 not_reported（它们按库维度上报）。",
    },
    search_knowledge: {
      purpose: "检索证据：文档分块、Wiki 页面、知识图谱三类来源；支持混合/语义/关键词检索，以及编号类精确串的字面匹配。",
      actions: [
        ["（单动作）", "一次调用可组合 sources 与 mode；match=literal 时文档来源改为字面匹配（要求端点开放 grep 许可）。"],
      ],
      steps: [
        "先用「回读原文」的 list 动作找一篇 parse_status=completed 的文档，记住标题里的一个词。",
        "sources=[document]、mode=hybrid：确认 results.document.results 非空并核对命中的内容。",
        "换 match=literal 用编号 / 口令等精确串再检索一次，对比结果差异。",
        "需要 Wiki 或图谱证据时把 sources 换成 [\"wiki\"] / [\"graph\"]（图谱必须显式给 knowledge_base_ids）。",
      ],
      expect: "results.<source>.results 非空；来源不可用时返回 partial=true 并给出 failed_sources 与具体原因。",
      pitfalls: "库没开 Wiki / 图谱时该来源会失败并写明原因（不是工具坏了）；图谱库还需配置实体与关系类型；limit 上限 30。",
    },
    read_document: {
      purpose: "浏览与回读原文：list 列出文档目录或 Wiki 目录，read 按文档 id 读正文（可只取相关段）或按 slug 读 Wiki 页。",
      actions: [
        ["list", "source_type=document：列出知识库的文档（含解析状态，用于挑一篇来读）；source_type=wiki：列出 Wiki 页面并给出 slug。"],
        ["read", "source_type=document：按 knowledge_id 读正文，query 可只返回包含该词的片段；source_type=wiki：按 slug 读整页。"],
      ],
      steps: [
        "list + knowledge_base_id：记下一篇 parse_status=completed 文档的 id 与标题。",
        "read + knowledge_id（limit 3）：核对 document.chunks 内容；total_chunks / truncated 说明还有多少没读。",
        "（Wiki）list + source_type=wiki 取一个 slug，再 read + source_type=wiki + slug + knowledge_base_id 读整页。",
      ],
      expect: "list 返回 documents.documents 与 total；read 返回 document.chunks 非空、且内容与原文一致。",
      pitfalls: "列表动作 knowledge_base_id 必填；Wiki 的 read 需要 knowledge_base_id 与 slug 同时给出；文档未解析完成时正文可能为空。",
    },
    ask: {
      purpose: "让 WeKnora 用自己的问答链回答：可选内置模式或端点发布的问答档案，返回回答、引用与 session_id。",
      actions: [
        ["（单动作）", "省略 mode 用端点默认档案；mode=quick-answer / smart-reasoning 钉住内置模式；带 session_id 续问同一会话。"],
      ],
      steps: [
        "先不带 session_id 问一个问题（示例 1 用 quick-answer），记下返回的 session_id 与 references。",
        "再问一个追问并把上面的 session_id 填进 session_id 字段：应返回同一个 session_id 且能沿用上文。",
        "拿 references 里的 knowledge_id / chunk_id 去「回读原文」核对引用是否真实存在于原文。",
      ],
      expect: "answer 非空、references 有引用条目；续问返回同一个 session_id；换知识库范围或换模式后续问会被拒绝并提示新开会话。",
      pitfalls: "会话绑定「端点 + 应答配置 + 有效知识库集合」，任一变化都会拒绝续问；smart-reasoning 需要工作区配置 Rerank 模型；省略 knowledge_base_ids 时按端点/档案配置解析范围。",
    },
  };

  // FIELD_HELP 逐字段中文说明（含默认值与书写格式），比接口英文原文更适合自测阅读。
  const FIELD_HELP = {
    "knowledge_base.action": "必填：list=列库 / get=看详情 / create=新建。",
    "knowledge_base.knowledge_base_id": "get 必填：要查看的知识库 id（从 list 结果里取）。",
    "knowledge_base.include_capabilities": "get 可选，默认 true：是否附带解析器目录与已发布问答档案。",
    "knowledge_base.name": "create 必填：新知识库名称，例如「演示库-诊断」。",
    "knowledge_base.description": "create 可选：一句话描述。",
    "knowledge_base.enable_wiki": "create 可选，默认 false：建库后是否生成 Wiki 页面。",
    "knowledge_base.enable_graph": "create 可选，默认 false：是否开启图谱抽取（建议同时填实体/关系类型）。",
    "knowledge_base.enable_keyword": "create 可选，默认 true：关键词索引。",
    "knowledge_base.enable_vector": "create 可选，默认 true：语义（向量）索引。",
    "knowledge_base.graph_entities": "create 选填：实体类型名，每行一个，例如 人员 / 项目 / 服务。",
    "knowledge_base.graph_relations": "create 选填：关系，每行一条「起点,终点,类型」，例如 人员,项目,负责。",
    "knowledge_base.embedding_model_id": "create 可选：覆盖工作区默认的向量模型 id（一般留空）。",
    "knowledge_base.summary_model_id": "create 可选：覆盖工作区默认的问答模型 id（一般留空）。",

    "ingest_document.action": "必填：submit=提交文件 / status=查阶段。",
    "ingest_document.knowledge_base_id": "submit 必填：目标知识库 id。",
    "ingest_document.file": "submit 必填，对象：{name:文件名, encoding:\"base64\", content:文件字节的 base64}。示例里已生成一段可用的 Markdown。",
    "ingest_document.process_config": "submit 可选，对象：指定解析引擎，如 {\"parser_engine_rules\":[{\"file_types\":[\"pdf\"],\"engine\":\"builtin\"}]}；引擎名从 knowledge_base.get 的目录里选。",
    "ingest_document.idempotency_key": "submit 建议填：一次上传操作的标识（UUID）；同标识配同一份字节可幂等重放，配不同字节会被拒绝。",
    "ingest_document.ingest_id": "status 二选一：submit 返回的 ingest_id。",
    "ingest_document.document_id": "status 二选一：文档 id（已知文档时可直接查）。",

    "search_knowledge.query": "必填：检索词或问题，例如文档标题里的一个词。",
    "search_knowledge.knowledge_base_ids": "可选：限定检索哪些库，每行一个 id；留空=范围内全部可见库。图谱来源必须显式给。",
    "search_knowledge.sources": "可选，默认 [document]：document=文档分块 / wiki=Wiki 页面 / graph=知识图谱；可多选。",
    "search_knowledge.mode": "可选，默认 hybrid：hybrid=向量+关键词 / semantic=语义 / keyword=关键词。",
    "search_knowledge.match": "可选：literal=按字面匹配（核对编号、金额等），要求端点开放 grep 许可。",
    "search_knowledge.limit": "可选，默认 10，最大 30：每个来源返回上限。",

    "read_document.action": "必填：list=列目录 / read=读正文。",
    "read_document.source_type": "可选，默认 document：document=文档 / wiki=Wiki 页面。",
    "read_document.knowledge_base_id": "list 必填；读 Wiki 页时也必需。要浏览的知识库 id。",
    "read_document.knowledge_id": "read（文档）必填：文档 id，从 list 结果里取。",
    "read_document.slug": "read（Wiki）必填：页面标识，从 list + source_type=wiki 的结果里取。",
    "read_document.query": "read 可选：只返回包含该词的片段，适合大文档抽查。",
    "read_document.offset": "read 可选，默认 0：从第几个分块开始读。",
    "read_document.limit": "read 可选：本次读取的分块数（默认 20，示例用 3 便于核对）。",
    "read_document.page": "list 可选，默认 1：页码。",
    "read_document.page_size": "list 可选：每页条数（示例 5）。",

    "ask.question": "必填：要问的问题；诊断时建议问一个答案唯一、便于核对的小问题。",
    "ask.knowledge_base_ids": "可选：本次问答可读的库，每行一个 id；留空=按端点/档案配置解析（默认档案可能自带库集合）。",
    "ask.mode": "可选：quick-answer=固定检索链 / smart-reasoning=多步推理；留空=用端点发布的问答档案。",
    "ask.profile_id": "可选：端点发布的问答档案 id（来自 knowledge_base.get 的 qa_profiles），不能填内部 agent id。",
    "ask.session_id": "可选：上一次回答返回的 session_id，用于续问；要求端点、应答配置与有效知识库集合都没变。",
  };
  function fieldHelp(toolName, field) {
    return FIELD_HELP[`${toolName}.${field}`] || FIELD_HELP[field] || "";
  }

  // 核心工具的 inputSchema 没写 JSON Schema 的 default，但契约文本里明确
  // 了默认值。三态下拉必须把真实默认显示出来，否则「不传」会被误解成
  // 未指定；显式 true/false 仍然优先于这里的值。
  const BOOL_DEFAULTS = {
    "knowledge_base.enable_keyword": true,
    "knowledge_base.enable_vector": true,
    "knowledge_base.enable_graph": false,
    "knowledge_base.enable_wiki": false,
    "knowledge_base.include_capabilities": false,
  };
  function boolDefault(toolName, field, spec) {
    if (typeof spec.default === "boolean") return spec.default;
    const key = `${toolName}.${field}`;
    return key in BOOL_DEFAULTS ? BOOL_DEFAULTS[key] : undefined;
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
          <div class="sub">共 <b id="b-count">0</b> 个工具，来自五工具知识核心的 <span class="mono">tools/list</span>
          （<span class="mono">/mcp/core/:id</span>，配置 Token 后加载）。标「写」的会修改知识库数据，运行前会二次确认。</div>
          <input id="b-filter" class="input wide" placeholder="按中文名或工具名过滤…">
          <div class="tool-list" id="b-list" style="margin-top:10px"></div>
        </div>
        <div class="card">
          <div id="b-detail"><div class="empty">从左侧选择一个工具，这里会显示它能做什么、需要填什么</div></div>
        </div>
      </div>
      <div class="card">
        <h3>MCP 验证清单</h3>
        <div class="sub">对着「上传目标知识库」（或最近导入的那篇文档）把五工具核心的读取动作跑一遍：
        知识库列表/详情 → 导入状态 → 读原文 → 列文档 → 检索（含字面匹配）→ Wiki 目录/页面 → Wiki 检索 → 图谱检索。
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
      document_id: (M.doc && M.doc.id) || "",
      ingest_id: (M.receipt && M.receipt.ingest_id) || "",
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
    const usage = TOOL_USAGE[t.name] || null;
    const usageHtml = usage ? `
      <div class="tool-usage">
        <div class="kv"><b>用途</b>：${escapeHtml(usage.purpose)}</div>
        <div class="kv"><b>动作</b>：</div>
        <ul class="usage-list">${usage.actions.map(([a, d]) =>
          `<li><span class="mono">${escapeHtml(a)}</span> — ${escapeHtml(d)}</li>`).join("")}</ul>
        <div class="kv"><b>自测步骤</b>（按顺序，每步都用下面「填入示例」或手工填参）：</div>
        <ol class="usage-list">${usage.steps.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
        <div class="kv"><b>判定标准</b>：${escapeHtml(usage.expect)}</div>
        <div class="kv"><b>常见错误</b>：${escapeHtml(usage.pitfalls)}</div>
      </div>` : "";
    box.innerHTML = `
      <h3>${escapeHtml(cn)} <span class="mono small muted">${escapeHtml(t.name)}</span>
        ${t.destructive ? '<span class="badge err">会改数据</span>' : '<span class="badge ok">只读</span>'}</h3>
      <div class="sub">${escapeHtml(desc || "（暂无中文说明）")}</div>
      ${usageHtml}
      <details class="token-help"><summary>接口原始描述（MCP 契约，英文）</summary>
        <p>${escapeHtml(t.description || "（无描述）")}</p></details>
      <div class="row" style="align-items:center">
        <button id="b-example" class="btn ghost small">填入示例</button>
        <button id="b-example-next" class="btn ghost small">换一个示例</button>
        <span id="b-example-note" class="kv">示例会用当前知识库的真实数据填好参数，直接点「运行」就能看到结果。</span>
      </div>
      <div class="row">
        <div class="seg" id="b-mode"></div>
        <span class="grow"></span>
        <button id="b-run" class="btn${t.destructive ? " danger" : ""}">运行</button>
      </div>
      <div id="b-form" class="bench-form" style="margin-top:12px"></div>
      <div id="b-json" class="hidden"><textarea id="b-json-text" class="input wide mono" rows="8"></textarea></div>
      <div id="b-status" class="status-line" style="margin-top:10px"></div>
      <div id="b-result" class="result-pane" style="margin-top:10px"></div>`;
    B.formMode = "form";
    B.exampleIdx = -1;
    B.formInputs = {};
    B.extraArgs = {};
    buildForm(box.querySelector("#b-form"), t.inputSchema || {}, t.name);
    const modeWrap = box.querySelector("#b-mode");
    const modeButtons = [["form", "表单"], ["json", "JSON 编辑"]].map(([mode, label]) => {
      const btn = document.createElement("button");
      btn.dataset.m = mode;
      btn.textContent = label;
      btn.classList.toggle("on", mode === "form");
      btn.onclick = () => {
        const want = mode;
        const jsonBox = box.querySelector("#b-json-text");
        let args;
        try {
          if (want === "json") {
            args = readForm();
            jsonBox.value = JSON.stringify(args, null, 2);
          } else {
            args = JSON.parse(jsonBox.value || "{}");
            if (!args || typeof args !== "object" || Array.isArray(args)) {
              throw new Error("顶层必须是对象");
            }
          }
        } catch (e) {
          toast((want === "json" ? "表单转 JSON 失败：" : "JSON 解析失败：") + e.message, "err");
          return;  // 切换失败时保持当前模式与已填内容，不重置表单
        }
        B.formMode = want;
        modeButtons.forEach(b => b.classList.toggle("on", b === btn));
        const isForm = want === "form";
        box.querySelector("#b-form").classList.toggle("hidden", !isForm);
        box.querySelector("#b-json").classList.toggle("hidden", isForm);
        if (isForm) {
          // 回填 JSON 里的值：切回表单不应清空用户已填的内容。
          buildForm(box.querySelector("#b-form"), t.inputSchema || {}, t.name);
          applyArgsToForm(args);
        }
      };
      modeWrap.appendChild(btn);
      return btn;
    });
    box.querySelector("#b-example").onclick = () => fillToolExample(section, box);
    box.querySelector("#b-example-next").onclick = () => fillToolExample(section, box, true);
    box.querySelector("#b-run").onclick = () => runBenchTool(section, box);
  }

  function buildForm(container, schema, toolName) {
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
      // 中文详细说明优先；接口英文原文降级为悬停提示，不占版面。
      const help = fieldHelp(toolName, name) || spec.description || enumHint || "";
      const typeLabel = spec.type === "array" ? "字符串数组" : (spec.type === "object" ? "对象" : (spec.type || "any"));
      label.title = spec.description || "";
      label.innerHTML = `<span>${cn ? `${escapeHtml(cn)} ` : ""}<span class="mono muted">${escapeHtml(name)}</span>
        <span class="muted">(${escapeHtml(typeLabel)})</span>${req}</span>
        <span class="field-help">${escapeHtml(help)}</span>`;
      let el;
      if (Array.isArray(spec.enum)) {
        el = document.createElement("select"); el.className = "input wide";
        for (const v of spec.enum) {
          const o = document.createElement("option"); o.value = String(v); o.textContent = String(v); el.appendChild(o);
        }
      } else if (spec.type === "boolean") {
        // 布尔字段是三态：不传（用服务端默认）、显式 true、显式 false。
        // 单纯复选框无法表达「默认 true 但我要关掉」，所以用下拉。
        el = document.createElement("select"); el.className = "input wide";
        const fallback = boolDefault(toolName, name, spec);
        const def = fallback === true ? "true" : (fallback === false ? "false" : "未指定");
        for (const [value, text] of [["", `不传（使用默认：${def}）`],
                                     ["true", "true（开启）"],
                                     ["false", "false（关闭）"]]) {
          const o = document.createElement("option");
          o.value = value; o.textContent = text; el.appendChild(o);
        }
      } else if (spec.type === "number" || spec.type === "integer") {
        el = document.createElement("input"); el.type = "number"; el.className = "input wide";
      } else if (spec.type === "array") {
        el = document.createElement("textarea"); el.className = "input wide mono"; el.rows = 2;
        el.placeholder = "每行一个值（或逗号分隔）";
      } else if (spec.type === "object") {
        el = document.createElement("textarea"); el.className = "input wide mono"; el.rows = 4;
        el.placeholder = '{"name":"example.pdf","encoding":"base64","content":"..."}';
      } else if (["content", "question", "text", "query"].includes(name) || (spec.type === "string" && (spec.maxLength || 0) > 500)) {
        el = document.createElement("textarea"); el.className = "input wide"; el.rows = 3;
      } else {
        el = document.createElement("input"); el.className = "input wide";
      }
      label.appendChild(el);
      if (Array.isArray(spec.enum)) {
        // 取值范围提示放在控件之后：控件始终是字段行的第一个子元素。
        const hint = document.createElement("span");
        hint.className = "field-enum";
        hint.textContent = `取值范围：${spec.enum.join(" / ")}`;
        label.appendChild(hint);
      }
      container.appendChild(label);
      B.formInputs[name] = { el, spec };
    }
  }

  function readForm() {
    // 从 JSON 切回表单时，schema 之外的键留在 extraArgs，再次运行/切回 JSON
    // 都原样带回，不会因为表单没有对应控件而悄悄丢参数。
    const args = Object.assign({}, B.extraArgs || {});
    for (const [name, { el, spec }] of Object.entries(B.formInputs)) {
      if (spec.type === "boolean") {
        if (el.value === "true") args[name] = true;
        else if (el.value === "false") args[name] = false;
        continue;
      }
      const raw = (el.value || "").trim();
      if (!raw) continue;
      if (spec.type === "array") {
        args[name] = raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
      } else if (spec.type === "number" || spec.type === "integer") {
        args[name] = Number(raw);
      } else if (spec.type === "object") {
        try { args[name] = JSON.parse(raw); }
        catch (_) { throw new Error(`${fieldCN(name) || name} 必须是合法 JSON`); }
      } else {
        args[name] = raw;
      }
    }
    return args;
  }

  // applyArgsToForm 把一份参数对象回填到当前表单；JSON 切回表单、填入示例
  // 都走这里，保证两条路径的显示完全一致。schema 外的键进 extraArgs。
  function applyArgsToForm(args) {
    B.extraArgs = {};
    const known = new Set(Object.keys(B.formInputs));
    for (const [name, { el, spec }] of Object.entries(B.formInputs)) {
      if (!(name in args)) { el.value = ""; continue; }
      const v = args[name];
      if (spec.type === "boolean") {
        el.value = v ? "true" : "false";
        continue;
      }
      if (Array.isArray(spec.enum) && !spec.enum.map(String).includes(String(v))) {
        // 下拉里没有这个值：保留在 extraArgs，不让表单静默改成别的选项。
        B.extraArgs[name] = v;
        el.value = "";
        continue;
      }
      if (spec.type === "array") el.value = Array.isArray(v) ? v.join("\n") : String(v);
      else if (spec.type === "object") el.value = JSON.stringify(v, null, 2);
      else el.value = v == null ? "" : String(v);
    }
    for (const [name, v] of Object.entries(args)) {
      if (!known.has(name)) B.extraArgs[name] = v;
    }
  }

  /* ---- 每个工具的「能真跑出结果」示例 ---- */

  // EX 缓存示例用到的真实 id，避免每次点「填入示例」都重查一遍。
  const EX = { kbId: "", docId: "", docTitle: "", docWord: "", wikiKbId: "", wikiSlug: "" };

  function exampleKbId() {
    return S.uploadTargetKbId || (S.kbs[0] && S.kbs[0].id) || "";
  }

  // exampleKbFor 挑一个真正开启了某项能力的知识库：Wiki / 图谱示例如果落到没
  // 开该能力的库上，工具必然报「未配置」，那不是工具坏了而是挑错了库。
  // capableKbs 列出真正具备某项能力的知识库。图谱额外看 graph_ready：
  // 只开了开关但没配实体/关系类型的库，图谱查询照样会被拒（抽不出东西）。
  function capableKbs(capability) {
    const kbs = S.kbs || [];
    return kbs.filter(k => capability === "graph"
      ? (k.graph_ready !== undefined ? !!k.graph_ready : !!(k.capability_flags || {}).graph)
      : !!(k.capability_flags || {})[capability]);
  }


  function capabilityHint(toolName, args, errorText) {
    const text = String(errorText || "");
    const sources = (args && args.sources) || [];
    const needsGraph = sources.includes("graph") || /GRAPH_/.test(text);
    const needsWiki = sources.includes("wiki") || /wiki/i.test(` ${toolName} ${text}`);
    if (!needsGraph && !needsWiki) return "";
    const cap = needsGraph ? "graph" : "wiki";
    const label = cap === "graph" ? "知识图谱" : "Wiki";
    const capable = capableKbs(cap);
    if (!capable.length) {
      const switchedOn = (S.kbs || []).filter(k => (k.capability_flags || {})[cap]);
      if (cap === "graph" && switchedOn.length) {
        return `《${switchedOn.map(k => k.name).join("、")}》开了图谱但没配实体/关系类型，` +
          "所以抽不出任何关系；新建知识库时填上实体类型和关系即可（「填入示例」会自动切到可用的库）。";
      }
      return `当前可见的知识库里没有开启${label}的，可在「资料解析」页新建一个（勾选对应能力）并上传资料。`;
    }
    return `这不是工具坏了：当前范围里没有${cap === "graph" ? "可用的" : "开启"}${label}的库。` +
      `可用的有：${capable.map(k => k.name).join("、")}（在「填入示例」里会自动切到它）。`;
  }

  async function exampleNewestDoc(kbId) {
    if (EX.kbId === kbId && EX.docId) return EX;
    const r = await api("/api/tool", {
      method: "POST",
      json: { name: "read_document",
              arguments: { action: "list", knowledge_base_id: kbId, page_size: 5 } },
      headers: materialsHeaders(), brief: "取示例文档",
    });
    const block = ((r.data && r.data.result) || {}).documents || {};
    const docs = block.documents || [];
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


  // demoSubmitFile 生成一段小 Markdown 作为 submit 示例的字节（UTF-8 安全的 base64）。
  function demoSubmitFile() {
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const text = `# 控制台诊断示例\n\n这是 ${stamp} 由「开发诊断」页通过 ingest_document.submit 导入的演示文档。\n`;
    return { name: `diagnose-demo-${Date.now()}.md`, encoding: "base64",
             content: btoa(unescape(encodeURIComponent(text))) };
  }

  // findFirstSlug 在 Wiki 目录结果里递归取第一个 slug（结构随页面类型变化）。
  function findFirstSlug(node) {
    if (node && typeof node === "object") {
      if (typeof node.slug === "string" && node.slug) return node.slug;
      for (const v of Object.values(node)) {
        const found = findFirstSlug(v);
        if (found) return found;
      }
    }
    return "";
  }

  async function exampleWikiPage(kbId) {
    if (EX.wikiKbId === kbId && EX.wikiSlug) return EX;
    const r = await api("/api/tool", {
      method: "POST",
      json: { name: "read_document",
              arguments: { action: "list", source_type: "wiki", knowledge_base_id: kbId } },
      headers: materialsHeaders(), brief: "取示例 Wiki 页",
    });
    const block = ((r.data && r.data.result) || {}).wiki || {};
    const slug = findFirstSlug(block);
    EX.wikiKbId = kbId; EX.wikiSlug = slug;
    if (!slug) {
      throw new Error("该知识库的 Wiki 目录里没有页面（可能尚未生成 Wiki），换一个库或先生成");
    }
    return EX;
  }

  // TOOL_EXAMPLES：每个工具的可直接运行示例，按顺序循环；参数全部来自当前真实状态。
  const TOOL_EXAMPLES = {
    knowledge_base: [
      { label: "list：列出可见知识库",
        expect: "knowledge_bases 非空，每个库带能力标记",
        build: async () => ({ args: { action: "list" } }) },
      { label: "get：查看目标库详情（含解析器目录与问答档案）",
        expect: "status.status.documents 有值、parser_engines.engines 非空",
        build: async () => {
          const kbId = exampleKbId();
          if (!kbId) throw new Error("没有可见的知识库，先在「资料解析」页新建一个");
          return { args: { action: "get", knowledge_base_id: kbId, include_capabilities: true },
                   note: `用的是《${kbName(kbId)}》` };
        } },
      { label: "create：新建演示库（写操作，会真的建库）",
        expect: "返回新库 id；随后用 list 能看到它",
        build: async () => ({
          args: { action: "create", name: "演示知识库-" + new Date().toISOString().slice(0, 10),
                  description: "由「开发诊断」页创建", enable_wiki: false, enable_graph: false },
          note: "创建成功后新库会自动加入本端点范围，可在「资料解析」页直接用它上传",
        }) },
    ],
    ingest_document: [
      { label: "submit：导入一段演示 Markdown（写操作）",
        expect: "返回 stage=queued、非空 ingest_id 与 document_id",
        build: async () => {
          const kbId = exampleKbId();
          if (!kbId) throw new Error("没有可见的知识库，先在「资料解析」页新建一个");
          return { args: { action: "submit", knowledge_base_id: kbId, file: demoSubmitFile(),
                           idempotency_key: uuid4() },
                   note: "运行后记下返回的 ingest_id，再切到 status 示例轮询；同内容重复提交会 dedup" };
        } },
      { label: "status：查询最近一次导入的阶段",
        expect: "phases.parse / index 最终变为 completed",
        build: async () => {
          const ingestId = (M.receipt && M.receipt.ingest_id) || "";
          const docId = (M.doc && M.doc.id) || "";
          if (!ingestId && !docId) throw new Error("还没有导入记录：先用 submit 示例提交一次，或在「资料解析」页导入");
          const args = { action: "status" };
          if (ingestId) args.ingest_id = ingestId; else args.document_id = docId;
          return { args, note: ingestId ? "用的是资料页最近一次的 ingest_id" : "按最近一次的 document_id 查询" };
        } },
      { label: "status：按文档 id 查（已知文档时直接查）",
        expect: "document.parse_status / index_status 有明确状态",
        build: async () => {
          const kbId = exampleKbId();
          await exampleNewestDoc(kbId);
          if (!EX.docId) throw new Error("目标知识库里还没有文档，先用 submit 示例导入一份");
          return { args: { action: "status", document_id: EX.docId },
                   note: `用的是《${EX.docTitle || EX.docId}》` };
        } },
    ],
    search_knowledge: [
      { label: "document：混合检索最近文档的标题词",
        expect: "results.document.results 非空",
        build: async () => {
          const kbId = exampleKbId();
          await exampleNewestDoc(kbId);
          return { args: { query: EX.docWord || "验收", knowledge_base_ids: kbId ? [kbId] : [],
                           sources: ["document"], mode: "hybrid", limit: 5 },
                   note: `检索词「${EX.docWord || "验收"}」取自《${EX.docTitle || kbId}》的标题` };
        } },
      { label: "document + literal：按字面匹配核对精确串",
        expect: "results.document.results 命中精确串",
        build: async () => {
          const kbId = exampleKbId();
          await exampleNewestDoc(kbId);
          return { args: { query: EX.docWord || "验收", knowledge_base_ids: kbId ? [kbId] : [],
                           sources: ["document"], match: "literal", limit: 5 },
                   note: "literal 需要在端点开放 grep 许可；核对编号、金额、口令这类精确串用它" };
        } },
      { label: "wiki：在 Wiki 页面里检索",
        expect: "results.wiki 命中页面（或 failed_sources 写明原因）",
        build: async () => {
          const kb = capableKbs("wiki").find(k => k.id === exampleKbId()) || capableKbs("wiki")[0];
          if (!kb) throw new Error("当前可见的知识库里没有开启 Wiki 的；可在「资料解析」页新建一个（勾选「同时生成 Wiki 页面」）");
          return { args: { query: EX.docWord || "总结", knowledge_base_ids: [kb.id],
                           sources: ["wiki"], limit: 5 },
                   note: `用的是《${kb.name}》（已开启 Wiki）` };
        } },
      { label: "graph：在知识图谱里查关系",
        expect: "results.graph.relations 非空（或写明图谱未配置）",
        build: async () => {
          const kb = capableKbs("graph").find(k => k.id === exampleKbId()) || capableKbs("graph")[0];
          if (!kb) throw new Error("当前可见的知识库里没有开启图谱的；可在「资料解析」页新建一个（勾选「同时抽取知识图谱」并填实体/关系）");
          return { args: { query: EX.docWord || "项目", knowledge_base_ids: [kb.id],
                           sources: ["graph"] },
                   note: `用的是《${kb.name}》（图谱需配置实体/关系类型；刚导入的资料要等抽取完成）` };
        } },
    ],
    read_document: [
      { label: "read：读回最近一篇文档的正文（前 3 段）",
        expect: "document.chunks 非空、内容与原文一致",
        build: async () => {
          const kbId = exampleKbId();
          await exampleNewestDoc(kbId);
          if (!EX.docId) throw new Error("目标知识库里还没有文档，先上传一份");
          return { args: { action: "read", knowledge_id: EX.docId, limit: 3 },
                   note: `用的是《${EX.docTitle || EX.docId}》` };
        } },
      { label: "list：列出目标库最近的文档（含解析状态）",
        expect: "documents.documents 与 total 有值",
        build: async () => {
          const kbId = exampleKbId();
          if (!kbId) throw new Error("没有可见的知识库");
          return { args: { action: "list", knowledge_base_id: kbId, page: 1, page_size: 5 },
                   note: `列的是《${kbName(kbId)}》` };
        } },
      { label: "read(wiki)：读一个 Wiki 页面",
        expect: "page 内容非空（或目录为空时给出原因）",
        build: async () => {
          const kb = capableKbs("wiki").find(k => k.id === exampleKbId()) || capableKbs("wiki")[0];
          if (!kb) throw new Error("当前可见的知识库里没有开启 Wiki 的");
          const ex = await exampleWikiPage(kb.id);
          return { args: { action: "read", source_type: "wiki", slug: ex.wikiSlug,
                           knowledge_base_id: kb.id },
                   note: `读的是《${kb.name}》的 slug=${ex.wikiSlug}` };
        } },
    ],
    ask: [
      { label: "quick-answer：问一个答案唯一的小问题",
        expect: "answer 非空、references 有引用；记下 session_id",
        build: async () => ({ args: { question: "这份资料里的负责人是谁？", mode: "quick-answer" },
                              note: "把返回的 session_id 记下来，用下一个示例续问" }) },
      { label: "smart-reasoning：多步推理模式",
        expect: "answer 非空（需要工作区配置 Rerank 模型，否则会明确报缺模型）",
        build: async () => ({ args: { question: "把这份资料的关键结论按条目总结出来。",
                                      mode: "smart-reasoning" } }) },
      { label: "续问：带上上一次的 session_id",
        expect: "返回同一个 session_id，回答能沿用上文",
        build: async () => ({ args: { question: "上一个问题里提到的结论还有哪些细节？",
                                      session_id: "" },
                              note: "把上一次 ask 返回的 session_id 粘进 session_id 字段再运行；换了知识库范围或模式需要新开会话" }) },
    ],
  };

  function kbName(kbId) {
    return ((S.kbs || []).find(k => k.id === kbId) || {}).name || kbId;
  }

  async function fillToolExample(section, box, advance) {
    const note = box.querySelector("#b-example-note");
    const t = B.tool;
    if (!t) return;
    note.classList.remove("err");
    const list = TOOL_EXAMPLES[t.name] || [{ label: "（无预设示例）", build: async () => ({ args: {} }) }];
    const next = advance || B.exampleIdx >= 0 ? (B.exampleIdx + 1) % list.length : 0;
    note.textContent = "正在准备示例参数…";
    let resolved;
    try {
      resolved = await list[next].build();
    } catch (e) {
      note.classList.add("err");
      note.textContent = e.message;
      return;
    }
    B.exampleIdx = next;
    const args = resolved.args || {};
    if (B.formMode === "json") {
      box.querySelector("#b-json-text").value = JSON.stringify(args, null, 2);
    } else {
      applyArgsToForm(args);
    }
    const item = list[next];
    note.textContent = `示例 ${next + 1}/${list.length}：${item.label}` +
      (resolved.note ? `｜${resolved.note}` : "") +
      (item.expect ? `｜预期：${item.expect}` : "");
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
      try { args = readForm(); }
      catch (e) { toast(e.message, "err"); return; }
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
      const hint = capabilityHint(t.name, args, `${d.error_code || ""} ${d.error || ""}`);
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
      Object.assign(M, { file: null, receipt: null, doc: null, steps: [], summary: null,
                            mounted: false, preview: null, lastStatus: null, lastPhases: null,
                            idemAuto: true });
      docPollSeq++;  // 旧身份的轮询循环立即失效
      Object.assign(Q, { sessionId: "", busy: false, mounted: false });
      Object.assign(B, { tool: null, mounted: false });
      Object.assign(D, { mounted: false, kbId: "", loadedKb: "", docs: [], total: 0,
                             page: 1, selectedId: "", selected: null, doc: null, chunks: [],
                             query: "", error: "", readError: "", loading: false,
                             readLoading: false, reqSeq: D.reqSeq + 1, readSeq: D.readSeq + 1 });
      for (const name of ["materials", "docs", "qa", "bench"]) {
        document.getElementById("view-" + name).innerHTML = "";
      }
      this.show(S.ui.view, document.getElementById("view-" + S.ui.view));
    },
    show(name, section) {
      if (name === "materials" && !M.mounted) materialsMount(section);
      if (name === "docs" && !D.mounted) docsMount(section);
      if (name === "qa" && !Q.mounted) qaMount(section);
      if (name === "bench" && !B.mounted) benchMount(section);
      if (name === "bench" && B.mounted) renderToolList(section, "");
      if (name === "materials") { syncKbSelect(section); syncEngineSelect(section); }
      if (name === "docs" && D.mounted) syncDocsKb(section);
      if (name === "qa") { qaScopeChips(section); renderQaScopeLine(section); updateQaSendState(section); }
    },
    onSelectionChanged() {
      if (M.mounted) {
        const materials = document.getElementById("view-materials");
        syncKbSelect(materials);
        syncEngineSelect(materials);
      }
      if (D.mounted) syncDocsKb(document.getElementById("view-docs"));
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
