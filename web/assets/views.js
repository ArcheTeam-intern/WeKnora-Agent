/* MCP 验证控制台 — 三视图：资料与解析验证 / 问答 / MCP 工具台 */
"use strict";

(function () {
  const { S, api, sse, toast, confirmDialog, renderMarkdown, escapeHtml, mcpHeaders } = window.App;

  /* ===================== 视图一：资料与解析验证 ===================== */
  const M = {
    file: null, channel: "multipart", receipt: null, doc: null,
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
        <h3><span class="step-no">1</span>上传文档（双通道）</h3>
        <div class="sub">默认走 <b>multipart 上传端点</b>（/mcp/&lt;id&gt;/uploads，验证传输契约：字段顺序、Idempotency-Key、错误码透传）；
        可切换 <b>upload_file 工具</b>（base64 纯 MCP 通道）。</div>
        <div class="row">
          <div class="seg" id="m-channel">
            <button data-ch="multipart" class="on">multipart 上传端点</button>
            <button data-ch="tool">upload_file 工具</button>
          </div>
        </div>
        <div class="row">
          <label class="field grow"><span>目标知识库</span><select id="m-kb" class="input"></select></label>
          <label class="field"><span>Idempotency-Key（UUID）</span>
            <input id="m-idem" class="input mono" style="width:320px" autocomplete="off"></label>
          <button id="m-idem-gen" class="btn ghost small">生成</button>
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
      </div>

      <div class="card">
        <h3><span class="step-no">2</span>导入并解析</h3>
        <div class="sub">import_document_file 原子领取上传回执并触发解析；成功后会立即自动运行验证清单（清单内含解析状态轮询）。</div>
        <div class="row">
          <button id="m-import" class="btn" disabled>导入</button>
          <span class="kv">document：<b id="m-doc" class="mono">–</b></span>
        </div>
        <div class="row"><span id="m-import-status" class="status-line"></span></div>
      </div>

      <div class="card">
        <h3><span class="step-no">3</span>MCP 验证清单</h3>
        <div class="sub">一次上传把读侧工具全验一遍：状态轮询 → read_document → list_documents → 检索 → Wiki → 图谱 → 知识库状态。
        按 KB 能力自动跳过不适用项；<b>红叉 = 工具失败</b>，跳过永远带原因（配置态不会伪装成失败）。</div>
        <div class="row">
          <button id="m-run-checklist" class="btn ghost">运行 / 重跑清单</button>
          <span id="m-summary" class="status-line"></span>
          <span class="grow"></span>
          <button id="m-download" class="btn ghost" disabled>下载清单 JSON</button>
        </div>
        <div id="m-checklist"><div class="empty">上传并导入后自动运行；也可先点「运行 / 重跑清单」验证已有文档。</div></div>
      </div>

      <div class="card">
        <h3><span class="step-no">4</span>写工具：add / update / delete_document</h3>
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
      </div>
    `;

    // --- 通道切换 ---
    section.querySelectorAll("#m-channel button").forEach(btn => {
      btn.onclick = () => {
        M.channel = btn.dataset.ch;
        section.querySelectorAll("#m-channel button").forEach(b => b.classList.toggle("on", b === btn));
      };
    });

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

    // --- 上传 ---
    section.querySelector("#m-upload").onclick = async () => {
      const st = section.querySelector("#m-upload-status");
      const kb = section.querySelector("#m-kb").value;
      if (!window.App.activeProfile()) { toast("请先登录", "err"); return; }
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
      const r = await api(path, {
        method: "POST", body: fd,
        headers: idem ? { "Idempotency-Key": idem } : {},
        brief: `上传 ${M.file.name}`,
      });
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

    // --- 导入 ---
    section.querySelector("#m-import").onclick = async () => {
      const st = section.querySelector("#m-import-status");
      if (!M.receipt) { st.textContent = "请先上传"; st.classList.add("err"); return; }
      st.classList.remove("err");
      st.textContent = "导入中（import_document_file）…";
      const r = await api("/api/import", {
        method: "POST", json: { knowledge_base_id: M.receipt.kb, upload_id: M.receipt.upload_id },
        brief: "import_document_file",
      });
      const res = (r.data && r.data.result) || {};
      const doc = res.document || {};
      if (!r.ok || !(r.data && r.data.ok)) {
        st.textContent = "导入失败：" + ((r.data && r.data.error) || r.error || r.status);
        st.classList.add("err");
        return;
      }
      M.doc = { id: doc.id || res.document_id || "", title: doc.title || "" };
      section.querySelector("#m-doc").textContent = M.doc.id || "–";
      section.querySelector("#m-op-id").value = M.doc.id || "";
      st.textContent = `已入队（queued=${res.queued} dedup=${res.deduplicated}）；开始验证清单…`;
      runChecklist(section);
    };

    // --- 清单 ---
    section.querySelector("#m-run-checklist").onclick = () => runChecklist(section);
    section.querySelector("#m-download").onclick = () => {
      const payload = {
        generated_at: new Date().toISOString(),
        endpoint: (S.endpoint && S.endpoint.endpoint_id) || "",
        knowledge_base_id: (M.receipt && M.receipt.kb) || section.querySelector("#m-kb").value,
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
    };

    // --- 写工具 ---
    section.querySelector("#m-op").onchange = () => {
      const op = section.querySelector("#m-op").value;
      section.querySelector("#m-op-content").closest(".row").classList.toggle("hidden", op === "delete_document");
      section.querySelector("#m-op-title").closest(".row").classList.toggle("hidden", op === "delete_document");
    };
    section.querySelector("#m-op-run").onclick = async () => {
      const st = section.querySelector("#m-op-status");
      const op = section.querySelector("#m-op").value;
      const kb = section.querySelector("#m-kb").value;
      const id = section.querySelector("#m-op-id").value.trim();
      const title = section.querySelector("#m-op-title").value.trim();
      const content = section.querySelector("#m-op-content").value;
      let args;
      if (op === "add_document") {
        if (!kb || !title || !content) { st.textContent = "add 需要 目标库 + 标题 + 内容"; st.classList.add("err"); return; }
        args = { knowledge_base_id: kb, title, content };
      } else if (op === "update_document") {
        if (!id || !content) { st.textContent = "update 需要 knowledge_id + 内容"; st.classList.add("err"); return; }
        args = { knowledge_id: id, content };
        if (title) args.title = title;
      } else {
        if (!id) { st.textContent = "delete 需要 knowledge_id"; st.classList.add("err"); return; }
        const okGo = await confirmDialog({
          title: "删除文档", danger: true, confirmText: "永久删除", typed: title || undefined,
          message: `将通过 MCP delete_document 删除：\n${id}\n${title ? "（输入标题以确认）" : "该操作不可撤销。"}`,
        });
        if (!okGo) return;
        args = { knowledge_id: id };
      }
      if (op !== "delete_document") {
        const okGo = await confirmDialog({
          title: `执行 ${op}`, message: `将经 MCP 调用 ${op}：\n${JSON.stringify(args, null, 2).slice(0, 600)}`,
        });
        if (!okGo) return;
      }
      st.classList.remove("err");
      st.textContent = "执行中…";
      const r = await api("/api/tool", { method: "POST", json: { name: op, arguments: args }, brief: op });
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
    };

    M.mounted = true;
    syncKbSelect(section);
  }

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
    if (prev && S.kbs.some(k => k.id === prev)) sel.value = prev;
    else if (S.selection.length) sel.value = S.selection[0];
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
    const kb = (M.receipt && M.receipt.kb) || section.querySelector("#m-kb").value;
    if (!kb) { toast("请选择目标知识库", "err"); return; }
    if (!window.App.activeProfile()) { toast("请先登录", "err"); return; }
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
      toast("清单运行失败：" + e.message, "err");
    } finally {
      const p = table.querySelector("#m-cl-progress");
      if (p) p.classList.remove("cursor");
    }
  }

  /* ===================== 视图二：问答 ===================== */
  const Q = { mode: "ask", sessionId: "", busy: false, mounted: false };

  function qaMount(section) {
    section.innerHTML = `
      <div class="card">
        <div class="row">
          <div class="seg" id="qa-mode">
            <button data-mode="ask" class="on">ask 工具（MCP 直连）</button>
            <button data-mode="agent">LangChain Agent（多工具编排）</button>
          </div>
          <span class="grow"></span>
          <span class="kv">session：<b id="qa-session" class="mono">–</b></span>
          <button id="qa-new" class="btn ghost small">新会话</button>
        </div>
        <div class="sub" id="qa-hint">ask = 一次 MCP 调用，走 WeKnora 自己的回答管线并返回 references 引用卡片；
        agent = 模型自主挑选多个 MCP 工具（浏览器顶栏的 KB 选择生效）。</div>
      </div>
      <div id="qa-msgs"><div class="empty">还没有对话。在下面输入问题开始验证。</div></div>
      <div class="card">
        <div class="row">
          <textarea id="qa-q" class="input grow" rows="2" placeholder="输入问题，Enter 发送（Shift+Enter 换行）"></textarea>
          <button id="qa-send" class="btn">发送</button>
        </div>
      </div>`;

    section.querySelectorAll("#qa-mode button").forEach(btn => {
      btn.onclick = () => {
        Q.mode = btn.dataset.mode;
        section.querySelectorAll("#qa-mode button").forEach(b => b.classList.toggle("on", b === btn));
        section.querySelector("#qa-hint").textContent = Q.mode === "ask"
          ? "ask = 一次 MCP 调用，走 WeKnora 自己的回答管线并返回 references 引用卡片。"
          : "agent = 模型自主挑选多个 MCP 工具（浏览器顶栏的 KB 选择生效）。";
      };
    });
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
    Q.mounted = true;
  }

  async function qaAsk(section) {
    if (Q.busy) return;
    if (!window.App.activeProfile()) { toast("请先登录", "err"); return; }
    const input = section.querySelector("#qa-q");
    const question = input.value.trim();
    if (!question) return;
    Q.busy = true;
    section.querySelector("#qa-send").disabled = true;
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

    const finish = () => {
      statusEl.classList.remove("cursor");
      if (!answerEl.textContent.trim() && !statusEl.textContent.trim()) statusEl.remove();
      Q.busy = false;
      section.querySelector("#qa-send").disabled = false;
    };

    try {
      if (Q.mode === "ask") {
        await sse("/api/ask", { question, session_id: Q.sessionId || undefined }, evt => {
          if (evt.type === "status") statusEl.textContent = evt.text;
          else if (evt.type === "answer") {
            statusEl.remove();
            answerEl.innerHTML = renderMarkdown(evt.text || "（空回答）");
            if (evt.session_id) {
              Q.sessionId = evt.session_id;
              section.querySelector("#qa-session").textContent = evt.session_id.slice(0, 12) + "…";
            }
            for (const ref of evt.references || []) {
              const card = document.createElement("div");
              card.className = "ref-card";
              card.innerHTML = `<div class="t">${escapeHtml(ref.knowledge_title || ref.title || "引用")}</div>
                <div>${escapeHtml((ref.excerpt || "").slice(0, 220))}</div>
                <div class="meta">chunk ${escapeHtml(String(ref.chunk_id || "").slice(0, 12))}… · score ${ref.score ?? "-"}</div>`;
              refsEl.appendChild(card);
            }
          } else if (evt.type === "error") {
            statusEl.textContent = evt.message || "调用失败";
            statusEl.classList.add("err");
          }
        });
      } else {
        await sse("/api/chat", { question }, evt => {
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
            answerEl.innerHTML = renderMarkdown(evt.text || "");
          } else if (evt.type === "error") {
            statusEl.textContent = evt.message || "运行失败";
            statusEl.classList.add("err");
          }
        });
      }
    } catch (e) {
      statusEl.textContent = "连接失败：" + e.message;
      statusEl.classList.add("err");
    } finally {
      finish();
      msgs.scrollTop = msgs.scrollHeight;
    }
  }

  /* ===================== 视图三：MCP 工具台 ===================== */
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
      <div class="bench">
        <div class="card">
          <h3>工具目录</h3>
          <div class="sub">来自 MCP <span class="mono">tools/list</span>（登录后加载）。</div>
          <input id="b-filter" class="input wide" placeholder="过滤工具名…">
          <div class="tool-list" id="b-list" style="margin-top:10px"></div>
        </div>
        <div class="card">
          <div id="b-detail"><div class="empty">从左侧选择一个工具</div></div>
        </div>
      </div>`;
    section.querySelector("#b-filter").oninput = e => renderToolList(section, e.target.value.trim().toLowerCase());
    B.mounted = true;
    renderToolList(section, "");
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
    show(name, section) {
      if (name === "materials" && !M.mounted) materialsMount(section);
      if (name === "qa" && !Q.mounted) qaMount(section);
      if (name === "bench" && !B.mounted) benchMount(section);
      if (name === "bench" && B.mounted) renderToolList(section, "");
      if (name === "materials") syncKbSelect(section);
    },
    onSelectionChanged() {
      if (M.mounted) syncKbSelect(document.getElementById("view-materials"));
    },
  };
  window.Views = Views;
})();