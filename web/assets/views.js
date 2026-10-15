/* MCP 验证控制台 — 三视图：资料与解析验证 / 问答 / MCP 工具台 */
"use strict";

(function () {
  const { S, api, sse, toast, confirmDialog, renderMarkdown, escapeHtml, mcpHeaders,
          captureIdentityEpoch, isCurrentIdentityEpoch } = window.App;

  /* ===================== 视图一：资料与解析验证 ===================== */
  const M = {
    file: null, channel: "tool", receipt: null, doc: null,
    steps: [], summary: null, mounted: false,
  };

  function uuid4() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

function materialsMount(section) {
    section.innerHTML = `
      <div class="card">
        <h3><span class="step-no">1</span>上传你的资料</h3>
        <div class="sub">文件上传到「目标知识库」——本次上传、导入与状态查询只作用于它。上传通道只决定字节如何送达 WeKnora，解析方式在下一步单独选择。</div>
        <div class="row">
          <label class="field grow"><span>目标知识库（本次上传目标）</span>
            <select id="m-kb" class="input"></select></label>
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
        <details class="token-help"><summary>高级：上传请求标识（同 key 同字节幂等重放）</summary>
          <div class="row" style="margin-top:8px">
            <input id="m-idem" class="input mono grow" autocomplete="off">
            <button id="m-idem-gen" class="btn ghost small">生成</button>
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
        <div class="sub">由 WeKnora 完成解析与索引：状态轮询 → 读取原文 → 检索核对，结果与所用引擎都会显示在下方。</div>
        <div class="row">
          <button id="m-import" class="btn" disabled>导入</button>
          <span class="kv">document：<b id="m-doc" class="mono">–</b></span>
        </div>
        <div class="row"><span id="m-import-status" class="status-line"></span></div>
        <div id="m-doc-status"></div>
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
    };

    // --- 文件选择 / 拖拽 ---
    const drop = section.querySelector("#m-drop");
    const fileInput = section.querySelector("#m-file");
    const setName = f => {
      M.file = f || null;
      const nameEl = section.querySelector("#m-file-name");
      if (f) { nameEl.textContent = `${f.name} · ${(f.size / 1024).toFixed(1)} KB`; nameEl.classList.remove("hidden"); }
      else { nameEl.classList.add("hidden"); }
    };
    drop.onclick = () => fileInput.click();
    fileInput.onchange = () => setName(fileInput.files[0]);
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("dragover"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", e => {
      e.preventDefault(); drop.classList.remove("dragover");
      if (e.dataTransfer.files.length) setName(e.dataTransfer.files[0]);
    });
    section.querySelector("#m-idem").value = uuid4();
    section.querySelector("#m-idem-gen").onclick = () => {
      section.querySelector("#m-idem").value = uuid4();
    };

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
      const idem = section.querySelector("#m-idem").value.trim();
      st.classList.remove("err");
      st.textContent = `上传中（${M.channel}）…`;
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
      if (!r.ok || !receipt || !(receipt.upload_id || (receipt.receipt && receipt.receipt.upload_id))) {
        st.textContent = "上传失败：" + (d.error ? (d.error.message || JSON.stringify(d.error)) : (r.error || r.status));
        st.classList.add("err");
        return;
      }
      const rr = receipt.receipt || receipt;
      M.receipt = Object.assign({ channel: M.channel, kb }, rr);
      st.textContent = "上传成功";
      renderReceipt(section);
      section.querySelector("#m-import").disabled = false;
      section.querySelector("#m-import-status").textContent = "";
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
      section.querySelector("#m-doc").textContent = M.doc.id || "–";
      const applied = res.process_config_applied;
      st.textContent = `已入队（queued=${res.queued} dedup=${res.deduplicated}` +
        (applied === undefined ? "" : ` · 解析选项${applied ? "已提交" : "未重新应用"}`) + "）";
      if (res.note && applied === false) st.textContent += " — " + res.note;
      pollDocStatus(section);
    };

    M.mounted = true;
    M.engine = M.engine || "__default__";
    syncKbSelect(section);
    syncEngineSelect(section);
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

  // pollDocStatus 轮询解析状态并回显 requested / applied 引擎，导入后可见。
  async function pollDocStatus(section) {
    const box = section.querySelector("#m-doc-status");
    const docId = M.doc && M.doc.id;
    if (!box || !docId) return;
    const epoch = captureIdentityEpoch();
    box.innerHTML = "";
    for (let i = 0; i < 40; i++) {
      const r = await api(`/api/document_status?knowledge_id=${encodeURIComponent(docId)}`,
        { headers: materialsHeaders(), brief: "get_document_status" });
      if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
      const status = ((r.data || {}).result || {}).status || {};
      const requested = Array.isArray(status.requested_parser_engine_rules) && status.requested_parser_engine_rules.length
        ? status.requested_parser_engine_rules.map(x => `${(x.file_types || []).join("/")}→${x.engine}`).join("; ")
        : "知识库默认";
      const div = document.createElement("div");
      div.className = "kv";
      div.textContent = `解析：${status.parse_status || "?"} · 索引：${status.index_status || "?"}` +
        ` · 请求引擎：${requested}` +
        (status.applied_parser_engine ? ` · 实际引擎：${status.applied_parser_engine}` : "") +
        (status.error_message ? ` · 错误：${status.error_message}` : "");
      box.innerHTML = "";
      box.appendChild(div);
      if (["completed", "failed", "cancelled"].includes(status.parse_status)) return;
      await new Promise(res => setTimeout(res, 3000));
    }
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
// Q.scopeAll/qbIds/mode 由 app.js 的状态渲染；exec entry 单独是 LangChain。
  const Q = { exec: "native", sessionId: "", busy: false, mounted: false };

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
        「端点默认」使用端点配置的 agent。以下「LangChain 验证链」是独立入口，与原生模式二选一。</div>
        <div class="row">
          <label class="kv" style="display:flex;gap:6px;align-items:center">
            <input type="checkbox" id="qa-langchain"> 使用 LangChain 验证链（独立开发验证入口，非 WeKnora 原生模式）
          </label>
        </div>
      </div>
      <div id="qa-msgs"><div class="empty">还没有对话。选择范围后输入问题开始。</div></div>
      <div class="card">
        <div class="row">
          <textarea id="qa-q" class="input grow" rows="2" placeholder="先选择问答知识库范围再提问"></textarea>
          <button id="qa-send" class="btn" disabled>发送</button>
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
    section.querySelector("#qa-langchain").onchange = e => {
      Q.exec = e.target.checked ? "langchain" : "native";
      section.querySelectorAll("#qa-mode button").forEach(b => { b.disabled = e.target.checked; });
      setQaScopeChanged(section);
    };
    section.querySelector("#qa-new").onclick = () => {
      Q.sessionId = "";
      section.querySelector("#qa-session").textContent = "–";
      section.querySelector("#qa-msgs").innerHTML = '<div class="empty">已开新会话。</div>';
    };
    const input = section.querySelector("#qa-q");
    section.querySelector("#qa-send").onclick = () => qaAsk(section);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); qaAsk(section); }
    });
    // 初始渲染：范围 chips、模式按钮、会话状态
    section.querySelectorAll("#qa-mode button").forEach(b => {
      b.classList.toggle("on", (b.dataset.mode || "") === (S.qaMode || ""));
      b.disabled = Q.exec === "langchain";
    });
    section.querySelector("#qa-langchain").checked = Q.exec === "langchain";
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
      if (Q.exec === "native") {
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
      } else {
        await sse("/api/chat", { question }, evt => {
          if (stale()) return;
          if (evt.type === "status") statusEl.textContent = evt.text;
          else if (evt.type === "tool") {
            statusEl.remove();
            const chip = document.createElement("div");
            chip.className = "tool-chip";
            chip.innerHTML = `<b>🔧 ${escapeHtml(evt.name)}</b> ${escapeHtml(evt.args || "")}`;
            toolsEl.appendChild(chip);
          } else if (evt.type === "tool_result" && evt.status === "error") {
            const last = [...toolsEl.children].reverse()[0];
            if (last) last.classList.add("err");
          } else if (evt.type === "answer") {
            if (statusEl.parentNode) statusEl.remove();
            const rendered = renderCitations(stripThinking(evt.text));
            answerEl.innerHTML = renderMarkdown(rendered.text);
            attachmentsForRefs(refsEl, [], rendered);
          } else if (evt.type === "error") {
            statusEl.textContent = evt.message || "运行失败";
            statusEl.classList.add("err");
          }
        }, window.App.qaHeaders());
      }
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
        <div class="sub">这里放验证与开发用能力：MCP 工具台、验证清单、Markdown 写工具。主流程（上传解析、知识问答）在其余两页。</div>
      </div>
      <div class="bench">
        <div class="card">
          <h3>工具目录</h3>
          <div class="sub">来自 MCP <span class="mono">tools/list</span>（配置 Token 后加载）。</div>
          <input id="b-filter" class="input wide" placeholder="过滤工具名…">
          <div class="tool-list" id="b-list" style="margin-top:10px"></div>
        </div>
        <div class="card">
          <div id="b-detail"><div class="empty">从左侧选择一个工具</div></div>
        </div>
      </div>
      <div class="card">
        <h3>MCP 验证清单</h3>
        <div class="sub">对上传目标知识库（或最近导入的文档）跑一遍读侧工具：状态轮询 → read_document → list_documents → 检索 → Wiki → 图谱 → 知识库状态。
        按 KB 能力自动跳过不适用项；红叉 = 工具失败，跳过永远带原因。</div>
        <div class="row">
          <button id="m-run-checklist" class="btn ghost">运行 / 重跑清单</button>
          <span id="m-summary" class="status-line"></span>
          <span class="grow"></span>
          <button id="m-download" class="btn ghost" disabled>下载清单 JSON</button>
        </div>
        <div id="m-checklist"><div class="empty">在资料页完成一次导入后自动运行；也可在此直接验证已有文档。</div></div>
      </div>
      <div class="card">
        <h3>写工具：add / update / delete_document</h3>
        <div class="sub">破坏性操作会二次确认；update/delete 仅对 Markdown 文档生效。删除时需输入文档标题确认。</div>
        <div class="row">
          <label class="field"><span>操作</span>
            <select id="m-op" class="input select">
              <option value="add_document">add_document</option>
              <option value="update_document">update_document</option>
              <option value="delete_document">delete_document</option>
            </select></label>
          <label class="field grow"><span>knowledge_id（update / delete 必填）</span>
            <input id="m-op-id" class="input mono" autocomplete="off"></label>
        </div>
        <div class="row"><label class="field grow"><span>标题（add 必填；update 留空保留原标题）</span>
          <input id="m-op-title" class="input"></label></div>
        <div class="row"><label class="field grow"><span>Markdown 内容（add / update 必填）</span>
          <textarea id="m-op-content" class="input" rows="4"></textarea></label></div>
        <div class="row"><button id="m-op-run" class="btn">执行</button>
          <span id="m-op-status" class="status-line"></span></div>
        <div id="m-op-result"></div>
      </div>`;
    section.querySelector("#b-filter").oninput = e => renderToolList(section, e.target.value.trim().toLowerCase());
    section.querySelector("#m-run-checklist").onclick = () => runChecklist(section);
    section.querySelector("#m-download").onclick = () => downloadChecklist(section);
    section.querySelector("#m-op").onchange = () => {
      const op = section.querySelector("#m-op").value;
      section.querySelector("#m-op-content").closest(".row").classList.toggle("hidden", op === "delete_document");
      section.querySelector("#m-op-title").closest(".row").classList.toggle("hidden", op === "delete_document");
    };
    section.querySelector("#m-op-run").onclick = () => runWriteTool(section);
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

  // runWriteTool 执行 add/update/delete_document（诊断用，带二次确认）。
  async function runWriteTool(section) {
    const epoch = captureIdentityEpoch();
    const st = section.querySelector("#m-op-status");
    const op = section.querySelector("#m-op").value;
    const kb = S.uploadTargetKbId;
    const id = section.querySelector("#m-op-id").value.trim();
    const title = section.querySelector("#m-op-title").value.trim();
    const content = section.querySelector("#m-op-content").value;
    let args;
    if (op === "add_document") {
      if (!kb || !title || !content) { st.textContent = "add 需要 上传目标知识库 + 标题 + 内容"; st.classList.add("err"); return; }
      args = { knowledge_base_id: kb, title, content };
    } else if (op === "update_document") {
      if (!id || !content) { st.textContent = "update 需要 knowledge_id + 内容"; st.classList.add("err"); return; }
      args = { knowledge_id: id, content };
      if (title) args.title = title;
    } else {
      if (!id) { st.textContent = "delete 需要 knowledge_id"; st.classList.add("err"); return; }
      const okGo = await confirmDialog({
        title: "删除文档", danger: true, confirmText: "永久删除", typed: title || undefined,
        message: `将通过 MCP delete_document 删除：
${id}
${title ? "（输入标题以确认）" : "该操作不可撤销。"}`,
      });
      if (!okGo) return;
      args = { knowledge_id: id };
    }
    if (op !== "delete_document") {
      const okGo = await confirmDialog({
        title: `执行 ${op}`, message: `将经 MCP 调用 ${op}：
${JSON.stringify(args, null, 2).slice(0, 600)}`,
      });
      if (!okGo) return;
    }
    st.classList.remove("err");
    st.textContent = "执行中…";
    const r = await api("/api/tool", {
      method: "POST", json: { name: op, arguments: args },
      headers: materialsHeaders(), brief: op,
    });
    if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
    const d = r.data || {};
    st.textContent = d.ok ? `成功（${d.latency_ms}ms）` : `失败：${d.error || r.error || r.status}`;
    if (!d.ok) st.classList.add("err");
    const box = section.querySelector("#m-op-result");
    box.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "raw small";
    pre.textContent = JSON.stringify(d, null, 2);
    box.appendChild(pre);
    if (d.ok && op === "add_document") {
      const newId = ((d.result || {}).document || {}).id || "";
      if (newId) section.querySelector("#m-op-id").value = newId;
    }
  }

  function renderToolList(section, filter) {
    const list = section.querySelector("#b-list");
    list.innerHTML = "";
    if (!S.tools.length) { list.innerHTML = '<div class="empty">登录后加载工具目录</div>'; return; }
    const groups = {};
    for (const t of S.tools) {
      if (filter && !t.name.toLowerCase().includes(filter)) continue;
      (groups[groupOf(t.name)] = groups[groupOf(t.name)] || []).push(t);
    }
    for (const [g, items] of Object.entries(groups)) {
      const h = document.createElement("div");
      h.className = "tool-group"; h.textContent = g;
      list.appendChild(h);
      for (const t of items) {
        const btn = document.createElement("button");
        btn.className = "tool-item" + (B.tool && B.tool.name === t.name ? " on" : "");
        btn.innerHTML = `<span>${escapeHtml(t.name)}</span>${t.destructive ? '<span class="destructive">写</span>' : ""}`;
        btn.onclick = () => { B.tool = t; renderToolDetail(section); renderToolList(section, filter); };
        list.appendChild(btn);
      }
    }
    if (!list.children.length) list.innerHTML = '<div class="empty">没有匹配的工具</div>';
  }

  function renderToolDetail(section) {
    const box = section.querySelector("#b-detail");
    const t = B.tool;
    box.innerHTML = `
      <h3>${escapeHtml(t.name)} ${t.destructive ? '<span class="badge err">破坏性</span>' : '<span class="badge ok">只读</span>'}</h3>
      <div class="sub">${escapeHtml(t.description || "（无描述）")}</div>
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
      label.innerHTML = `<span>${escapeHtml(name)} <span class="muted">(${escapeHtml(spec.type || "any")})</span>${req} —
        ${escapeHtml(spec.description || "")}</span>`;
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

  async function runBenchTool(section, box) {
    const epoch = captureIdentityEpoch();
    const t = B.tool;
    let args;
    if (B.formMode === "json") {
      try { args = JSON.parse(box.querySelector("#b-json-text").value || "{}"); }
      catch (e) { toast("JSON 解析失败：" + e.message, "err"); return; }
    } else {
      args = readForm();
    }
    if (t.destructive) {
      const okGo = await confirmDialog({
        title: `运行破坏性工具 ${t.name}`, danger: true, confirmText: "运行",
        message: `该工具会修改 WeKnora 状态或消耗一次性凭据。\n\n参数：\n${JSON.stringify(args, null, 2).slice(0, 800)}`,
      });
      if (!okGo) return;
    }
    const st = box.querySelector("#b-status");
    st.classList.remove("err");
    st.textContent = "运行中…";
    const r = await api("/api/tool", { method: "POST", json: { name: t.name, arguments: args }, brief: t.name });
    if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
    const d = r.data || {};
    st.textContent = d.ok ? `成功 · ${d.latency_ms}ms · HTTP ${d.http_status ?? r.status}`
                          : `失败 · ${d.error || r.error || r.status}（${d.error_code || ""}）`;
    if (!d.ok) st.classList.add("err");
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
      Object.assign(M, { file: null, channel: "tool", receipt: null, doc: null, steps: [], summary: null, mounted: false });
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
