/* MCP 验证控制台 — 核心：状态、身份、KB 选择、轨迹抽屉、路由 */
"use strict";

const S = {
  accounts: [],           // 服务端账号档案（无密码）
  profiles: [],           // 浏览器本地档案（含 token）
  activeEmail: "",
  kbs: [],                // knowledge_base.list 结果
  tools: [],              // tools/list 结果（核心工具 core 面）
  // KB 范围按页面拆分：资料页只有一个上传目标；问答页有自己的检索范围与
  // 原生模式。两者互不干扰，也都不再由顶栏统一编辑。
  uploadTargetKbId: "",   // 资料页：上传/导入/状态请求只带这个库
  qaKbIds: [],            // 问答页：ask/chat 的检索范围（空 = 未选）
  qaScopeAll: false,      // 问答页显式选择「全部可用」时才不收窄
  qaAgentId: "",          // 当前身份在问答页选择的原生智能体
  qaMode: "",             // "" = 端点默认；quick-answer / smart-reasoning
  engines: [],            // knowledge_base.get 的解析器目录（资料页解析方式）
  endpoint: null,
  trace: [],
  ui: { view: "materials" },
};

const LS_PROFILES = "wk_console_profiles_v2";
const LS_ACTIVE = "wk_console_active_v2";
const LS_SCOPE = "wk_console_scope_v3";

/* ---------------- 身份 epoch ----------------
 * 每次身份变化（连接/切换/断开/401 失效）都推进一个单调递增的 epoch。
 * 任何异步操作在发起时捕获 epoch，在 await 之后、SSE 回调与 catch/finally
 * 写共享状态或 DOM 之前检查它；旧身份的迟到响应因此不能改写新身份的状态、
 * DOM 或 busy 标记，也不能把旧 session_id 带进新身份的后续请求。
 */
let identityEpoch = 0;
function captureIdentityEpoch() { return identityEpoch; }
function isCurrentIdentityEpoch(epoch) { return epoch === identityEpoch; }
function advanceIdentityEpoch() { identityEpoch += 1; return identityEpoch; }

/* 身份切换会替换该标签页的全部连接态：轨迹属于上一次连接，清掉避免混用。 */
function resetIdentityScopedState() {
  S.kbs = [];
  S.tools = [];
  S.engines = [];
  S.uploadTargetKbId = "";
  S.qaKbIds = [];
  S.qaScopeAll = false;
  S.qaAgentId = "";
  S.trace = [];
  saveScope();
  renderTrace();
  document.getElementById("tool-count").textContent = "–";
  renderScopeSummary();
}

/* ---------------- 本地存储 ---------------- */
function loadLocal() {
  try { S.profiles = JSON.parse(sessionStorage.getItem(LS_PROFILES) || "[]").map(p => TokenSession.normalize(p)); } catch (_) { S.profiles = []; }
  S.activeEmail = sessionStorage.getItem(LS_ACTIVE) || "";
  // Retire the old permanent JWT cache; credentials now last only this tab.
  localStorage.removeItem(LS_PROFILES);
  localStorage.removeItem(LS_ACTIVE);
  try {
    const scope = JSON.parse(localStorage.getItem(LS_SCOPE) || "{}");
    S.uploadTargetKbId = String(scope.uploadTargetKbId || "");
    S.qaKbIds = Array.isArray(scope.qaKbIds) ? scope.qaKbIds.filter(Boolean) : [];
    S.qaScopeAll = !!scope.qaScopeAll;
    S.qaMode = String(scope.qaMode || "");
  } catch (_) { /* 保持默认（全部未选） */ }
}
function saveProfiles() { sessionStorage.setItem(LS_PROFILES, JSON.stringify(S.profiles)); }
function saveScope() {
  localStorage.setItem(LS_SCOPE, JSON.stringify({
    uploadTargetKbId: S.uploadTargetKbId, qaKbIds: S.qaKbIds,
    qaScopeAll: S.qaScopeAll, qaMode: S.qaMode,
  }));
}
function activeProfile() {
  const p = S.profiles.find(p => p.email === S.activeEmail) || null;
  return p && p.expires_at * 1000 > Date.now() ? p : null;
}

/* ---------------- headers ----------------
 * The KB scope is per request and per page: no global selection exists any
 * more, so an upload target and a QA range can never disagree silently.
 */
function mcpHeaders(opts) {
  const p = activeProfile();
  if (!p) return {};
  const h = {
    "X-WeKnora-User-Token": p.token,
    "X-Tenant-ID": String(p.tenant_id || ""),
  };
  const kbIds = (opts && opts.kbIds) || [];
  if (kbIds.length) h["X-WeKnora-Knowledge-Base-Ids"] = kbIds.join(",");
  return h;
}
// 资料页：上传/导入/状态只作用于上传目标
function materialsHeaders() {
  return mcpHeaders({ kbIds: S.uploadTargetKbId ? [S.uploadTargetKbId] : [] });
}
// 问答页：显式「全部可用」时不收窄；未选任何库时同样不收窄但界面禁用发送
function qaHeaders() {
  return mcpHeaders({ kbIds: S.qaScopeAll ? [] : S.qaKbIds });
}

/* ---------------- 问答范围 epoch ----------------
 * 切换问答知识库范围或原生模式都会开启一个新的逻辑会话：旧范围/旧模式
 * 的在途回答不得写回新范围，也不能把旧 session_id 带进后续提问。
 */
let qaEpoch = 0;
function captureQaEpoch() { return qaEpoch; }
function isCurrentQaEpoch(epoch) { return epoch === qaEpoch; }
function advanceQaEpoch() {
  qaEpoch += 1;
  const q = window.Views && Views.resetQaScopeState ? Views.resetQaScopeState() : null;
  return qaEpoch;
}

/* ---------------- toast / modal ---------------- */
function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 8000 : 4200);
}
function openModal(build) {
  const root = document.getElementById("modal-root");
  const box = document.getElementById("modal-box");
  box.innerHTML = "";
  build(box);
  root.classList.remove("hidden");
}
function closeModal() { document.getElementById("modal-root").classList.add("hidden"); }
document.addEventListener("click", e => {
  if (e.target.classList && e.target.classList.contains("modal-mask")) closeModal();
});
function confirmDialog({ title, message, confirmText = "确认执行", danger = false, typed = "" }) {
  return new Promise(resolve => {
    openModal(box => {
      const h = document.createElement("h3"); h.textContent = title; box.appendChild(h);
      const p = document.createElement("div"); p.className = "sub"; p.style.whiteSpace = "pre-wrap"; p.textContent = message; box.appendChild(p);
      let input = null;
      if (typed) {
        const lab = document.createElement("label"); lab.className = "field";
        lab.innerHTML = `<span>输入 <b>${typed}</b> 以确认</span>`;
        input = document.createElement("input"); input.className = "input wide";
        lab.appendChild(input); box.appendChild(lab);
      }
      const actions = document.createElement("div"); actions.className = "modal-actions";
      const cancel = document.createElement("button"); cancel.className = "btn ghost"; cancel.textContent = "取消";
      const ok = document.createElement("button"); ok.className = "btn" + (danger ? " danger" : ""); ok.textContent = confirmText;
      actions.append(cancel, ok); box.appendChild(actions);
      cancel.onclick = () => { closeModal(); resolve(false); };
      ok.onclick = () => {
        if (typed && (!input || input.value.trim() !== typed)) { toast("确认文本不匹配", "err"); return; }
        closeModal(); resolve(true);
      };
      if (input) input.focus();
    });
  });
}

/* ---------------- 中文说明层（工具 / 字段 / 接口路径）----------------
 * 工具名、字段名和接口路径是 MCP 与服务端的英文契约，主产品会直接使用；
 * 这里只是给控制台加一层中文说明，不改变任何对外契约。
 */
const TOOL_CN = {
  knowledge_base: ["知识库", "action=list 列出可见知识库（含能力标记）；action=get 查看单个库的状态、解析器目录与已发布问答档案；action=create 新建知识库。"],
  ingest_document: ["导入文档", "action=submit 一次完成「上传 + 导入 + 解析」：文件字节 base64 随请求发送，可带 process_config 指定解析引擎；action=status 按 ingest_id / document_id 回报上传、解析、索引、Wiki、图谱各阶段。"],
  search_knowledge: ["检索证据", "在文档、Wiki、知识图谱里检索：sources 选择来源（document / wiki / graph），mode 选混合 / 语义 / 关键词，match=literal 做字面匹配（核对编号、金额）。"],
  read_document: ["回读原文", "action=list 列出知识库的文档目录或 Wiki 目录；action=read 读回文档正文（可分页）或 Wiki 页面（按 slug），用于核对引用。"],
  ask: ["知识问答", "WeKnora 原生问答：mode 选快速问答 / 智能推理，profile_id 用端点发布的配置，session_id 续问；返回回答与引用。"],
  agent_workspace: ["智能体管理", "列出、查看、新建、编辑、复制和删除 WeKnora 原生智能体；内置智能体只读，可复制后编辑。问答可通过 agent_id 指定智能体。"],
  wiki_workspace: ["Wiki 管理", "原生 Wiki 页面的新建、编辑、删除、版本历史与恢复，以及页面链接图。写操作需要端点显式授权和知识库写权限；修改正文中的 [[slug|标题]] 会更新页面链接。"],
};
const FIELD_CN = {
  action: "动作",
  knowledge_base_id: "知识库", knowledge_base_ids: "知识库范围", knowledge_id: "文档 ID",
  ingest_id: "导入 ID", document_id: "文档 ID", source_type: "来源类型", sources: "检索来源",
  match: "匹配方式", encoding: "编码", file: "文件", name: "名称", description: "描述",
  enable_wiki: "启用 Wiki", enable_graph: "启用图谱", include_capabilities: "包含能力目录",
  graph_entities: "图谱实体类型", graph_relations: "图谱关系",
  query: "查询词", limit: "条数上限", offset: "起始位置", page: "页码", page_size: "每页条数",
  agent_id: "智能体", config: "智能体配置", system_prompt: "系统提示词",
  agent_mode: "问答模式", agent_type: "智能体类型", kb_selection_mode: "知识库选择方式",
  model_id: "对话模型", rerank_model_id: "重排模型", knowledge_bases: "智能体知识库",
  retrieve_kb_only_when_mentioned: "仅在提及知识库时检索",
  mode: "模式", profile_id: "问答档案", session_id: "会话 ID", process_config: "解析配置",
  idempotency_key: "上传请求标识", slug: "页面标识", keyword: "关键词",
  title: "标题", content: "正文", summary: "摘要", page_type: "页面类型", status: "状态",
  version: "版本号", center: "中心页面标识", depth: "关联深度",
};
const PATH_CN = {
  "/api/kbs": "读取知识库列表",
  "/api/tools": "读取 MCP 工具目录",
  "/api/endpoint": "读取端点信息",
  "/api/parser-engines": "读取解析引擎目录",
  "/api/ingest": "上传并导入（ingest_document.submit）",
  "/api/ingest_status": "查询导入状态",
  "/api/kb_status": "查询知识库状态",
  "/api/documents": "文档目录（read_document.list）",
  "/api/document": "文档正文（read_document.read）",
  "/api/tool": "调用 MCP 工具",
  "/api/checklist": "运行验证清单",
  "/api/ask": "知识问答（原生模式）",
  "/api/local-credential": "读取本机凭证",
};
function toolCN(name) { return TOOL_CN[name] || [String(name || ""), ""]; }
function fieldCN(key) { return FIELD_CN[key] || ""; }
function pathCN(path, payload) {
  const base = String(path || "").split("?")[0];
  if (base === "/api/tool" && payload && payload.name) {
    const [cn] = toolCN(payload.name);
    return `调用工具：${cn}`;
  }
  return PATH_CN[base] || base || path;
}
function okStatus(status) { return !!status && status >= 200 && status < 300; }
function statusCN(status) {
  if (!status) return "失败";
  if (status >= 200 && status < 300) return "成功";
  if (status === 401) return "未授权";
  if (status === 403) return "无权限";
  if (status === 404) return "不存在";
  if (status === 409) return "冲突";
  if (status === 429) return "限流";
  return status >= 500 ? "服务端错误" : `失败 ${status}`;
}

/* ---------------- trace ---------------- */
function traceAdd(entry) {
  S.trace.unshift(TokenSession.redact(entry));
  if (S.trace.length > 200) S.trace.pop();
  renderTrace();
}
function renderTrace() {
  const count = document.getElementById("trace-count");
  if (count) count.textContent = String(S.trace.length);
  const list = document.getElementById("trace-list");
  if (!list) return;
  list.innerHTML = "";
  if (!S.trace.length) {
    list.innerHTML = '<div class="empty">暂无调用。所有经控制台的 MCP 请求都会记录在这里。</div>';
    return;
  }
  for (const t of S.trace) {
    const item = document.createElement("div");
    item.className = "trace-item";
    const ok = t.status >= 200 && t.status < 300;
    const action = t.title || pathCN(t.path, t.request);
    const context = t.brief ? ` · ${escapeHtml(t.brief)}` : "";
    item.innerHTML = `
      <div class="head">
        <span class="title-cn">${escapeHtml(action)}</span>
        <span class="badge ${ok ? "ok" : "err"}">${escapeHtml(t.label || statusCN(t.status))}</span>
      </div>
      <div class="meta">${t.latency_ms}ms · ${escapeHtml(t.at)}${context}</div>
      ${t.error ? `<div class="meta err-text">原因：${escapeHtml(String(t.error).slice(0, 200))}</div>` : ""}
      <div class="meta mono path-line">${escapeHtml(t.method + " " + t.path)}</div>
      <div class="detail"></div>`;
    const detail = item.querySelector(".detail");
    const pre = document.createElement("pre");
    pre.className = "raw small";
    pre.textContent = JSON.stringify({ request: t.request, response: t.response }, null, 2);
    detail.appendChild(pre);
    item.onclick = () => item.classList.toggle("open");
    list.appendChild(item);
  }
}

/* ---------------- HTTP ---------------- */
async function api(path, opts = {}) {
  const epoch = captureIdentityEpoch();
  const started = performance.now();
  const method = opts.method || "GET";
  const headers = Object.assign({}, mcpHeaders(), opts.headers || {});
  if (opts.identityOnly) delete headers['X-WeKnora-Knowledge-Base-Ids'];
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  let status = 0, data = null, errText = "";
  try {
    const resp = await fetch(path, { method, headers, body });
    status = resp.status;
    const text = await resp.text();
    try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 800) }; }
    if (!resp.ok) errText = (data && (data.error || data.detail)) || text.slice(0, 200);
  } catch (e) {
    errText = e.message;
  }
  const latency = Math.round(performance.now() - started);
  // 迟到的旧身份响应：不写轨迹、不触发失效、不把结果交给调用方继续写状态。
  if (!isCurrentIdentityEpoch(epoch)) {
    return { ok: false, stale: true, status, data: null, error: "身份已切换，忽略旧响应", latency_ms: latency };
  }
  const brief = opts.brief || (opts.json && opts.json.name) || "";
  traceAdd({
    method, path,
    title: opts.title || pathCN(path, opts.json),
    brief, status, label: statusCN(status), error: okStatus(status) ? "" : errText,
    latency_ms: latency,
    at: new Date().toLocaleTimeString(),
    request: opts.json !== undefined ? opts.json : (body ? "(multipart/form-data)" : undefined),
    response: data,
  });
  if (TokenSession.isAuthError(status, data || {})) invalidateCredential(headers['X-WeKnora-User-Token']);
  return { ok: status >= 200 && status < 300, status, data, error: errText, latency_ms: latency };
}
function invalidateCredential(requestToken) {
  const current = S.profiles.find(p => p.email === S.activeEmail);
  if (!TokenSession.canInvalidate(requestToken, current)) return;
  // 失效即身份变化：先推进 epoch，让所有在途请求的写回全部作废。
  advanceIdentityEpoch();
  S.profiles = S.profiles.filter(p => p.token !== requestToken);
  S.activeEmail = '';
  sessionStorage.removeItem(LS_ACTIVE);
  resetIdentityScopedState();
  saveProfiles(); renderUserSelect(); renderScopeSummary();
  if (window.Views) Views.onIdentityChanged();
  document.getElementById('endpoint-badge').textContent = 'MCP · 凭证已失效';
  toast('Token 已失效，请用独立凭证工具重新获取，再点击「配置 Token」导入。', 'err');
}

/* ---------------- SSE ---------------- */
async function sse(path, payload, onEvent, scopeHeaders) {
  const epoch = captureIdentityEpoch();
  // 调用方给出页面级身份头（问答范围），未给出时退化为仅身份头。
  const requestHeaders = Object.assign({ 'Content-Type': 'application/json' },
    scopeHeaders || mcpHeaders());
  const resp = await fetch(path, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(payload),
  });
  if (!isCurrentIdentityEpoch(epoch)) return;
  traceAdd({
    method: "POST", path, title: pathCN(path, payload),
    brief: payload.question || payload.knowledge_base_id || "",
    status: resp.status, label: okStatus(resp.status) ? "已受理（流式）" : statusCN(resp.status),
    latency_ms: 0, at: new Date().toLocaleTimeString(),
    request: payload, response: "(SSE 流，逐条见页面)",
  });
  if (!resp.ok || !resp.body) {
    if (resp.status === 401) invalidateCredential(requestHeaders['X-WeKnora-User-Token']);
    let detail = "";
    try { detail = (await resp.json()).error || ""; } catch (_) {}
    throw new Error(detail || ("HTTP " + resp.status));
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // 流可能跨越身份切换：切换后到站的帧一律丢弃，不投递给视图回调。
    if (!isCurrentIdentityEpoch(epoch)) return;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split(/\r?\n\r?\n/);
    buf = frames.pop();
    for (const frame of frames) {
      if (!isCurrentIdentityEpoch(epoch)) return;
      const line = frame.split(/\r?\n/).find(l => l.startsWith("data:"));
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
      if (TokenSession.isAuthError(resp.status, evt)) invalidateCredential(requestHeaders['X-WeKnora-User-Token']);
      if (!isCurrentIdentityEpoch(epoch)) return;
      onEvent(evt);
    }
  }
}

/* ---------------- markdown ---------------- */
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineMd(s) {
  return s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
function renderMarkdown(text) {
  const lines = escapeHtml(text).split(/\r?\n/);
  const out = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { out.push(`<h${heading[1].length}>${inlineMd(heading[2])}</h${heading[1].length}>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|")); i++;
      }
      if (rows.length > 1 && rows[1].every(c => /^\s*:?-{2,}:?\s*$/.test(c))) rows.splice(1, 1);
      const cell = c => `<td>${inlineMd(c.trim())}</td>`;
      const head = rows.shift().map(c => `<th>${inlineMd(c.trim())}</th>`).join("");
      const body = rows.map(r => `<tr>${r.map(cell).join("")}</tr>`).join("");
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`); continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMd(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`); i++;
      }
      out.push(`<ul>${items.join("")}</ul>`); continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() &&
           !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\|/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) {
      para.push(inlineMd(lines[i])); i++;
    }
    out.push(`<p>${para.join("<br>")}</p>`);
  }
  return out.join("");
}

/* ---------------- 顶栏：用户 ---------------- */
function renderUserSelect() {
  const sel = document.getElementById("user-select");
  sel.innerHTML = "";
  if (!S.profiles.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = TokenSession.DEFAULT_EMAIL;
    sel.appendChild(o);
    updateTokenStatus(); return;
  }
  for (const p of S.profiles) {
    const o = document.createElement("option");
    o.value = p.email;
    o.textContent = `${p.name}（${p.email}）`;
    if (p.email === S.activeEmail) o.selected = true;
    sel.appendChild(o);
  }
  updateTokenStatus();
}
function updateTokenStatus() {
  const el = document.getElementById("token-status");
  if (!el) return;
  const p = activeProfile();
  el.className = "badge " + (p ? "ok" : "gray");
  el.textContent = p ? "已连接 · " + new Date(p.expires_at * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + " 到期" : "待配置有效 Token";
}
function setActiveProfile(email) {
  // 切换用户即身份变化：推进 epoch 使旧身份的在途请求全部作废。
  advanceIdentityEpoch();
  S.activeEmail = email;
  sessionStorage.setItem(LS_ACTIVE, email);
  resetIdentityScopedState();
  renderUserSelect();
  renderScopeSummary();
  if (window.Views) Views.onIdentityChanged();
  return refreshAfterIdentity();
}

/* ---------------- 顶栏：只读范围摘要 ----------------
 * 顶栏不再提供全局可编辑选择器：上传目标和问答范围各自在页面里选择，
 * 顶栏只显示两者的当前值，避免「看到 A、实际写 B」这类冲突。
 */
function scopeSummaryText() {
  if (!activeProfile()) return "配置有效 Token 后加载知识库";
  if (!S.kbs.length) return "没有可见的知识库";
  const nameOf = id => (S.kbs.find(k => k.id === id) || {}).name || id.slice(0, 8);
  const upload = S.uploadTargetKbId ? nameOf(S.uploadTargetKbId) : "未选择";
  const qa = S.qaScopeAll ? "全部可用" : (S.qaKbIds.length ? S.qaKbIds.map(nameOf).join("、") : "未选择");
  return `共 ${S.kbs.length} 个知识库 · 资料页目标：${upload} · 问答范围：${qa}`;
}

function renderScopeSummary() {
  const el = document.getElementById("scope-summary");
  if (!el) return;
  el.textContent = scopeSummaryText();
}

async function loadKbs() {
  if (!activeProfile()) { S.kbs = []; renderScopeSummary(); return; }
  const epoch = captureIdentityEpoch();
  const r = await api("/api/kbs", { brief: "knowledge_base.list" });
  if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
  if (r.ok && r.data && r.data.ok) {
    S.kbs = r.data.result.knowledge_bases || [];
    const valid = new Set(S.kbs.map(k => k.id));
    // 不可见的库必须从两个页面的范围里同时剔除，避免把越权 id 发出去。
    if (S.uploadTargetKbId && !valid.has(S.uploadTargetKbId)) S.uploadTargetKbId = "";
    S.qaKbIds = S.qaKbIds.filter(id => valid.has(id));
    if (!S.uploadTargetKbId && S.kbs.length) S.uploadTargetKbId = S.kbs[0].id;
    saveScope();
  } else {
    S.kbs = [];
    toast("加载知识库失败：" + ((r.data && r.data.error) || r.error || r.status), "err");
  }
  renderScopeSummary();
  if (window.Views && Views.onSelectionChanged) Views.onSelectionChanged();
}

// loadEngines fetches the deployment's parser catalog through the core
// knowledge_base.get action. Endpoints that do not expose the underlying
// get_knowledge_base_status + list_parser_engines permissions fall back to
// "knowledge base default" instead of blocking the upload page.
async function loadEngines() {
  S.engines = [];
  if (!activeProfile()) { renderScopeSummary(); return; }
  const epoch = captureIdentityEpoch();
  const r = await api("/api/parser-engines", { brief: "knowledge_base.get（解析引擎）" });
  if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
  if (r.ok && r.data && r.data.ok) {
    S.engines = (r.data.result && r.data.result.engines) || [];
  } else {
    S.engines = [];
    toast("解析引擎目录不可用（knowledge_base.get 需要状态与解析器目录权限），将使用知识库默认解析", "err");
  }
  if (window.Views && Views.onSelectionChanged) Views.onSelectionChanged();
}

async function loadTools() {
  if (!activeProfile()) { S.tools = []; return; }
  const epoch = captureIdentityEpoch();
  const r = await api("/api/tools", { brief: "tools/list" });
  if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
  if (r.ok && r.data && r.data.ok) {
    S.tools = r.data.tools || [];
    document.getElementById("tool-count").textContent = String(S.tools.length);
  } else {
    toast("加载工具目录失败：" + ((r.data && r.data.error) || r.error || r.status), "err");
  }
}

async function loadEndpoint() {
  const badge = document.getElementById("endpoint-badge");
  if (!activeProfile()) { badge.className = "badge gray"; badge.textContent = "未登录"; return; }
  const epoch = captureIdentityEpoch();
  const r = await api("/api/endpoint", { brief: "MCP 连接信息" });
  if (!isCurrentIdentityEpoch(epoch) || r.stale) return;
  const d = r.data || {};
  S.endpoint = d;
  if (d.ok) {
    badge.className = "badge ok";
    badge.textContent = `MCP · ${(d.tools || []).length} 个工具`;
    badge.title = `endpoint_id=${d.endpoint_id || ""}`;
  } else {
    badge.className = "badge warn";
    badge.textContent = "MCP 暂未连接";
    badge.title = d.error || "";
  }
}

async function refreshAfterIdentity() {
  await Promise.all([loadKbs(), loadTools(), loadEndpoint()]);
  await loadEngines();
  if (window.Views) Views.onSelectionChanged();
}

/* ---------------- 登录 ---------------- */
async function openLoginDialog() {
  openModal(box => {
    const profile = activeProfile();
    box.innerHTML = `
      <div class="eyebrow">CONNECT YOUR WORKSPACE</div>
      <h3>连接知识工作台</h3>
      <p class="sub">导入独立凭证工具生成的文件，或填写 WeKnora 用户 Token。知识操作仅经 MCP；工作台不保存账号密码。</p>
      <div class="row credential-quick">
        <button id="credential-local" class="btn">🔄 读取本机凭证</button>
        <span class="muted" style="font-size:12px">由独立工具生成；过期时先在终端跑一次 scripts/refresh-credential.ps1</span>
      </div>
      <label class="credential-import">导入凭证 JSON<input id="credential-file" type="file" accept=".json,application/json"></label>
      <div class="credential-divider"><span>或者手动填写</span></div>
      <label class="field"><span>账号</span><input id="credential-email" class="input wide" type="email" autocomplete="username"></label>
      <label class="field"><span>工作空间 ID</span><input id="credential-workspace" class="input wide" inputmode="numeric" placeholder="例如 2"></label>
      <label class="field"><span>用户访问 Token（JWT）</span><input id="credential-token" class="input wide mono" type="password" autocomplete="off" placeholder="粘贴 WeKnora 签发的用户 Token"></label>
      <details class="token-help"><summary>如何获取新的 Token？</summary><p>在本仓库运行一条命令：<code>powershell -ExecutionPolicy Bypass -File scripts\refresh-credential.ps1</code>（内部调用 WeKnora 的官方签发工具，签发后同步 .env 供 CLI 使用、并写好凭证文件）；回到本弹窗点「读取本机凭证」即可。也可以直接粘贴主产品身份链路签发的 JWT。端点 Token 由服务端配置，无需在此填写。</p></details>
      <div id="credential-status" class="status-line" role="status"></div>
      <div class="modal-actions"><button id="credential-clear" class="btn ghost">断开连接</button><span class="grow"></span><button id="credential-cancel" class="btn ghost">取消</button><button id="credential-apply" class="btn">连接工作台</button></div>`;
    const email = box.querySelector('#credential-email');
    const workspace = box.querySelector('#credential-workspace');
    const token = box.querySelector('#credential-token');
    const status = box.querySelector('#credential-status');
    const button = box.querySelector('#credential-apply');
    email.value = profile?.email || TokenSession.DEFAULT_EMAIL;
    workspace.value = profile?.tenant_id || '2';
    let imported = null;
    // 读取本机凭证：只读取独立工具写下的文件（工作台不做登录、不碰密码），
    // 读到的凭据仍要经过下面的 MCP 校验才会成为有效连接。
    box.querySelector('#credential-local').onclick = async () => {
      const quick = box.querySelector('#credential-local');
      quick.disabled = true;
      status.classList.remove('err');
      status.textContent = '正在读取本机凭证文件…';
      try {
        const result = await api('/api/local-credential', { brief: '读取本机凭证' });
        const data = result.data || {};
        if (!result.ok || !data.available) throw new Error(data.hint || '没有可用的本机凭证');
        imported = data.credential;
        const value = TokenSession.normalize(imported);
        email.value = value.email;
        workspace.value = value.tenant_id;
        token.value = value.token;
        status.textContent = `凭证已读取（${data.credential.expires_at || '有效期未知'}），点击连接后由 WeKnora 校验。`;
      } catch (err) {
        status.classList.add('err');
        status.textContent = err.message;
      } finally { quick.disabled = false; }
    };
    box.querySelector('#credential-file').onchange = async e => {
      try {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 32768) throw new Error('凭证文件过大，请选择生成的 Token JSON');
        imported = JSON.parse(await file.text());
        const value = TokenSession.normalize(imported);
        email.value = value.email;
        workspace.value = value.tenant_id;
        token.value = value.token;
        status.classList.remove('err');
        status.textContent = '凭证已读取，点击连接后由 WeKnora 校验。';
      } catch (err) { status.classList.add('err'); status.textContent = err.message; }
    };
    box.querySelector('#credential-cancel').onclick = closeModal;
    box.querySelector('#credential-clear').onclick = () => {
      advanceIdentityEpoch();
      S.profiles = []; S.activeEmail = '';
      sessionStorage.removeItem(LS_PROFILES); sessionStorage.removeItem(LS_ACTIVE);
      resetIdentityScopedState();
      saveProfiles(); renderUserSelect(); renderScopeSummary();
      document.getElementById('endpoint-badge').textContent = 'MCP · 待连接';
      if (window.Views) Views.onIdentityChanged();
      closeModal(); toast('已断开，此标签页的 Token 已清除');
    };
    button.onclick = async () => {
      const oldProfiles = S.profiles, oldEmail = S.activeEmail;
      // 连接即身份变化：先推进 epoch，旧连接的在途请求不得再回写。
      const epoch = advanceIdentityEpoch();
      try {
        const value = TokenSession.normalize({ token: token.value,
          profile: { ...(imported?.profile || {}), email: email.value, tenant_id: workspace.value } });
        button.disabled = true; status.classList.remove('err'); status.textContent = '正在通过 MCP 校验连接…';
        S.profiles = [value]; S.activeEmail = value.email;
        resetIdentityScopedState();
        const result = await api('/api/kbs', { brief: '验证 MCP 用户凭证', identityOnly: true });
        if (!isCurrentIdentityEpoch(epoch) || result.stale) return;
        if (!result.ok || !result.data?.ok) throw new Error(result.data?.error || result.error || 'MCP 拒绝了此 Token，请重新获取');
        saveProfiles(); sessionStorage.setItem(LS_ACTIVE, value.email);
        renderUserSelect();
        if (window.Views) Views.onIdentityChanged();
        await refreshAfterIdentity();
        // 连接成功后清掉页面初始的「点击配置 Token」提示，避免它和成功提示叠在一起。
        document.getElementById('toasts').innerHTML = '';
        closeModal(); toast('已连接 ' + value.email, 'ok');
      } catch (err) {
        // 回滚也是身份变化：再次推进 epoch，让失败尝试期间的响应同样作废。
        advanceIdentityEpoch();
        S.profiles = oldProfiles; S.activeEmail = oldEmail;
        resetIdentityScopedState();
        saveProfiles(); renderUserSelect(); renderScopeSummary();
        status.classList.add('err'); status.textContent = err.message;
      } finally { button.disabled = false; }
    };
  });
}

/* ---------------- 路由 ---------------- */
function currentRoute() {
  const m = (location.hash || "").match(/^#\/(library|materials|docs|search|wiki|graph|agents|qa|bench)(?:[/?]|$)/);
  return m ? m[1] : "materials";
}
function applyRoute() {
  const route = currentRoute();
  S.ui.view = route;
  const headings = {
    library: ['你的知识，全貌可见', '查看资料规模、生成状态和可用能力，从这里走向检索与问答。'],
    materials: ['从一份资料开始', '上传、解析、核对原文，让每一次回答都有依据。'],
    docs: ['看清每一份资料', '浏览知识库里的文档，核对状态，读回带序号的分块原文。'],
    search: ['让证据先说话', '选择知识库与资料来源，对照文档、Wiki 与图谱检索到的证据。'],
    wiki: ['把资料连成知识', '浏览主题目录、搜索 Wiki 页面，并沿来源核对原文。'],
    graph: ['沿着关系发现知识', '按实体查询局部关系图，核对每条关系背后的资料。'],
    agents: ['让智能体按你的方式工作', '管理原生智能体，配置问答方式、系统提示词与知识库范围。'],
    qa: ['向知识提问', '连接你的资料，通过原文与引用找到可靠答案。'],
    bench: ['让每一次调用可见', '浏览可用能力，验证参数、结果与原文来源。'],
  };
  document.getElementById('page-title').textContent = headings[route][0];
  document.getElementById('page-description').textContent = headings[route][1];
  for (const name of ["library", "materials", "docs", "search", "wiki", "graph", "agents", "qa", "bench"]) {
    const sec = document.getElementById("view-" + name);
    sec.classList.toggle("hidden", name !== route);
    const nav = document.querySelector(`.nav-item[data-route="${name}"]`);
    if (nav) nav.classList.toggle("active", name === route);
    if (name === route && window.Views) Views.show(name, sec);
  }
}

/* ---------------- 初始化 ---------------- */
window.addEventListener("DOMContentLoaded", async () => {
  loadLocal();
  if (!S.activeEmail && S.profiles.length) S.activeEmail = S.profiles[0].email;
  renderUserSelect();
  renderScopeSummary();
  renderTrace();

  document.getElementById("login-btn").onclick = openLoginDialog;
  document.getElementById("user-select").onchange = e => {
    if (e.target.value) setActiveProfile(e.target.value);
  };
  const drawer = document.getElementById("trace-drawer");
  document.getElementById("trace-toggle").onclick = () => drawer.classList.toggle("open");
  document.getElementById("trace-close").onclick = () => drawer.classList.remove("open");
  document.getElementById("trace-clear").onclick = () => { S.trace = []; renderTrace(); };

  window.addEventListener("hashchange", applyRoute);
  applyRoute();

  // 标题固定为产品名。把 /api/info 的模型名拼进标签页会误导——控制台可以随时
  // 换模型，也不代表当前连接的就是那个模型。/api/info 仍保留：它是启动期的连通性
  // 探测，也记在「MCP 调用轨迹」里。
  document.title = "WeKnora MCP 控制台";
  await api("/api/info", { brief: "GET info" });
  if (activeProfile()) await refreshAfterIdentity();
  else toast("点击「配置 Token」，导入有效的 WeKnora 用户凭证");
  setInterval(updateTokenStatus, 30000);
});

/* 供 views.js 使用 */
window.App = {
  S, api, sse, toast, confirmDialog, openModal, closeModal,
  renderMarkdown, escapeHtml, mcpHeaders, materialsHeaders, qaHeaders,
  activeProfile, loadKbs, loadEngines, refreshAfterIdentity,
  captureIdentityEpoch, isCurrentIdentityEpoch, advanceIdentityEpoch, setActiveProfile,
  captureQaEpoch, isCurrentQaEpoch, advanceQaEpoch,
  saveScope, renderScopeSummary,
  toolCN, fieldCN, statusCN,
};
