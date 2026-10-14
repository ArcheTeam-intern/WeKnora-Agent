/* MCP 验证控制台 — 核心：状态、身份、KB 选择、轨迹抽屉、路由 */
"use strict";

const S = {
  accounts: [],           // 服务端账号档案（无密码）
  profiles: [],           // 浏览器本地档案（含 token）
  activeEmail: "",
  kbs: [],                // list_knowledge_bases 结果
  tools: [],              // tools/list 结果
  selection: [],          // 选中的 KB id
  endpoint: null,
  trace: [],
  ui: { view: "materials" },
};

const LS_PROFILES = "wk_console_profiles_v2";
const LS_ACTIVE = "wk_console_active_v2";
const LS_SELECTION = "wk_console_selection_v2";

/* ---------------- 本地存储 ---------------- */
function loadLocal() {
  try { S.profiles = JSON.parse(localStorage.getItem(LS_PROFILES) || "[]"); } catch (_) { S.profiles = []; }
  S.activeEmail = localStorage.getItem(LS_ACTIVE) || "";
  try { S.selection = JSON.parse(localStorage.getItem(LS_SELECTION) || "[]"); } catch (_) { S.selection = []; }
}
function saveProfiles() { localStorage.setItem(LS_PROFILES, JSON.stringify(S.profiles)); }
function saveSelection() { localStorage.setItem(LS_SELECTION, JSON.stringify(S.selection)); }
function activeProfile() { return S.profiles.find(p => p.email === S.activeEmail) || null; }

/* ---------------- headers ---------------- */
function mcpHeaders() {
  const p = activeProfile();
  if (!p) return {};
  const h = {
    "X-WeKnora-User-Token": p.token,
    "X-Tenant-ID": String(p.tenant_id || ""),
  };
  if (S.selection.length) h["X-WeKnora-Knowledge-Base-Ids"] = S.selection.join(",");
  return h;
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

/* ---------------- trace ---------------- */
function traceAdd(entry) {
  S.trace.unshift(entry);
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
    item.innerHTML = `
      <div class="head">
        <span class="path">${escapeHtml(t.method + " " + t.path)}</span>
        <span class="badge ${ok ? "ok" : "err"}">${t.status || "ERR"}</span>
      </div>
      <div class="meta">${escapeHtml(t.brief || "")} · ${t.latency_ms}ms · ${t.at}</div>
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
  const started = performance.now();
  const method = opts.method || "GET";
  const headers = Object.assign({}, mcpHeaders(), opts.headers || {});
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
  const brief = opts.brief || (opts.json && opts.json.name) || "";
  traceAdd({
    method, path, brief, status, latency_ms: latency,
    at: new Date().toLocaleTimeString(),
    request: opts.json !== undefined ? opts.json : (body ? "(multipart/form-data)" : undefined),
    response: data,
  });
  if (status === 401) toast("登录态失效：请重新登录该账号", "err");
  return { ok: status >= 200 && status < 300, status, data, error: errText, latency_ms: latency };
}

/* ---------------- SSE ---------------- */
async function sse(path, payload, onEvent) {
  const resp = await fetch(path, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, mcpHeaders()),
    body: JSON.stringify(payload),
  });
  traceAdd({
    method: "POST", path, brief: payload.question || payload.knowledge_base_id || "",
    status: resp.status, latency_ms: 0, at: new Date().toLocaleTimeString(),
    request: payload, response: "(SSE 流，逐条见页面)",
  });
  if (!resp.ok || !resp.body) {
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
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split(/\r?\n\r?\n/);
    buf = frames.pop();
    for (const frame of frames) {
      const line = frame.split(/\r?\n/).find(l => l.startsWith("data:"));
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
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
    o.value = ""; o.textContent = "（未登录）";
    sel.appendChild(o);
    return;
  }
  for (const p of S.profiles) {
    const o = document.createElement("option");
    o.value = p.email;
    o.textContent = `${p.name}（${p.email}）`;
    if (p.email === S.activeEmail) o.selected = true;
    sel.appendChild(o);
  }
}
function setActiveProfile(email) {
  S.activeEmail = email;
  localStorage.setItem(LS_ACTIVE, email);
  renderUserSelect();
  refreshAfterIdentity();
}

/* ---------------- 顶栏：KB 选择 ---------------- */
function renderKbChips() {
  const box = document.getElementById("kb-chips");
  box.innerHTML = "";
  if (!activeProfile()) { box.innerHTML = '<span class="muted">登录后自动加载…</span>'; return; }
  if (!S.kbs.length) { box.innerHTML = '<span class="muted">没有可见的知识库</span>'; return; }
  for (const kb of S.kbs) {
    const chip = document.createElement("span");
    const on = S.selection.includes(kb.id);
    chip.className = "chip" + (on ? " on" : "");
    const caps = [];
    const flags = kb.capability_flags || {};
    if (flags.vector) caps.push("向量");
    if (flags.keyword) caps.push("关键词");
    if (flags.wiki) caps.push("Wiki");
    if (flags.graph) caps.push("图谱");
    chip.innerHTML = `${escapeHtml(kb.name)}<span class="caps">${caps.join("·") || "无检索能力"}</span>`;
    chip.title = kb.id;
    chip.onclick = () => {
      S.selection = on ? S.selection.filter(id => id !== kb.id) : S.selection.concat([kb.id]);
      saveSelection();
      renderKbChips();
      if (window.Views) Views.onSelectionChanged();
    };
    box.appendChild(chip);
  }
}

async function loadKbs() {
  if (!activeProfile()) { S.kbs = []; renderKbChips(); return; }
  const r = await api("/api/kbs", { brief: "list_knowledge_bases" });
  if (r.ok && r.data && r.data.ok) {
    S.kbs = r.data.result.knowledge_bases || [];
    const valid = new Set(S.kbs.map(k => k.id));
    S.selection = S.selection.filter(id => valid.has(id));
    saveSelection();
  } else {
    S.kbs = [];
    toast("加载知识库失败：" + ((r.data && r.data.error) || r.error || r.status), "err");
  }
  renderKbChips();
}

async function loadTools() {
  if (!activeProfile()) { S.tools = []; return; }
  const r = await api("/api/tools", { brief: "tools/list" });
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
  const r = await api("/api/endpoint", { brief: "GET mcp-endpoint" });
  const d = r.data || {};
  S.endpoint = d;
  if (d.ok) {
    badge.className = "badge ok";
    badge.textContent = `${d.name || d.endpoint_id} · ${d.require_user_identity ? "用户模式" : "机器模式"} · ${(d.tools || []).length} 工具 · ${(d.knowledge_base_ids || []).length} KB`;
    badge.title = `endpoint_id=${d.endpoint_id} rate_limit=${d.rate_limit_per_minute || "-"}/min`;
  } else {
    badge.className = "badge warn";
    badge.textContent = `端点 ${d.endpoint_id || "?"}（管理接口不可读）`;
    badge.title = d.error || "";
  }
}

async function refreshAfterIdentity() {
  await Promise.all([loadKbs(), loadTools(), loadEndpoint()]);
  if (window.Views) Views.onSelectionChanged();
}

/* ---------------- 登录 ---------------- */
async function openLoginDialog() {
  const r = await api("/api/accounts", { brief: "GET accounts" });
  if (!r.ok || !r.data) { toast("无法读取账号档案", "err"); return; }
  S.accounts = r.data.accounts || [];
  openModal(box => {
    const h = document.createElement("h3"); h.textContent = "登录 WeKnora 账号"; box.appendChild(h);
    const note = document.createElement("div"); note.className = "sub";
    note.textContent = "凭据来自本机 accounts.json，只用于换取新鲜 JWT；控制台不缓存 token。";
    box.appendChild(note);
    const lab1 = document.createElement("label"); lab1.className = "field"; lab1.innerHTML = "<span>账号</span>";
    const sel = document.createElement("select"); sel.className = "input wide";
    for (const a of S.accounts) {
      const o = document.createElement("option"); o.value = a.email;
      o.textContent = `${a.name}（${a.email}）`; sel.appendChild(o);
    }
    lab1.appendChild(sel); box.appendChild(lab1);
    const lab2 = document.createElement("label"); lab2.className = "field"; lab2.innerHTML = "<span>密码</span>";
    const pw = document.createElement("input"); pw.type = "password"; pw.className = "input wide";
    lab2.appendChild(pw); box.appendChild(lab2);
    const status = document.createElement("div"); status.className = "status-line"; box.appendChild(status);
    const actions = document.createElement("div"); actions.className = "modal-actions";
    const cancel = document.createElement("button"); cancel.className = "btn ghost"; cancel.textContent = "取消";
    const ok = document.createElement("button"); ok.className = "btn"; ok.textContent = "登录";
    actions.append(cancel, ok); box.appendChild(actions);
    cancel.onclick = closeModal;
    ok.onclick = async () => {
      ok.disabled = true; status.textContent = "登录中…";
      const resp = await api("/api/login", { method: "POST", json: { email: sel.value, password: pw.value }, brief: "login " + sel.value });
      ok.disabled = false;
      if (!resp.ok || !resp.data || !resp.data.token) {
        status.textContent = "登录失败：" + ((resp.data && resp.data.error) || resp.error || resp.status);
        status.classList.add("err"); return;
      }
      const p = Object.assign({}, resp.data.profile, { token: resp.data.token });
      S.profiles = S.profiles.filter(x => x.email !== p.email).concat([p]);
      saveProfiles();
      closeModal();
      setActiveProfile(p.email);
      toast(`已登录 ${p.name}`, "ok");
    };
    pw.focus();
  });
}

/* ---------------- 路由 ---------------- */
function currentRoute() {
  const m = (location.hash || "").match(/^#\/(materials|qa|bench)/);
  return m ? m[1] : "materials";
}
function applyRoute() {
  const route = currentRoute();
  S.ui.view = route;
  for (const name of ["materials", "qa", "bench"]) {
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
  renderKbChips();
  renderTrace();

  document.getElementById("login-btn").onclick = openLoginDialog;
  document.getElementById("user-select").onchange = e => {
    if (e.target.value) setActiveProfile(e.target.value);
  };
  document.getElementById("kb-all").onclick = () => {
    S.selection = S.kbs.map(k => k.id); saveSelection(); renderKbChips();
    if (window.Views) Views.onSelectionChanged();
  };
  document.getElementById("kb-none").onclick = () => {
    S.selection = []; saveSelection(); renderKbChips();
    if (window.Views) Views.onSelectionChanged();
  };
  const drawer = document.getElementById("trace-drawer");
  document.getElementById("trace-toggle").onclick = () => drawer.classList.toggle("open");
  document.getElementById("trace-close").onclick = () => drawer.classList.remove("open");
  document.getElementById("trace-clear").onclick = () => { S.trace = []; renderTrace(); };

  window.addEventListener("hashchange", applyRoute);
  applyRoute();

  const info = await api("/api/info", { brief: "GET info" });
  if (info.ok && info.data) {
    document.title = `WeKnora MCP 控制台 · ${info.data.model || ""}`;
  }
  if (activeProfile()) await refreshAfterIdentity();
  else toast("请先点右上角「登录 / 切换」选择账号", "");
});

/* 供 views.js 使用 */
window.App = {
  S, api, sse, toast, confirmDialog, openModal, closeModal,
  renderMarkdown, escapeHtml, mcpHeaders, activeProfile, loadKbs, refreshAfterIdentity,
};