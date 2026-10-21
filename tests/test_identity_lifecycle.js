/*
 * Identity lifecycle regression: stale responses from a previous identity
 * must never write the new identity's state, DOM or busy flags, and an old
 * session id must not leak into the next identity's requests.
 *
 * The test drives the REAL web/assets/{session,app,views}.js through a vm
 * with a minimal fake DOM and a deferred fetch queue, so every assertion
 * exercises the shipped async code (not a copied helper).
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const ASSETS = path.join(__dirname, "..", "web", "assets");

/* ---------------- 最小 DOM ---------------- */
class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach(x => x && this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : !!force; on ? this.set.add(c) : this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
}
class El {
  constructor(tag = "div") {
    this.tagName = tag; this.children = []; this.classList = new ClassList();
    this.style = {}; this.dataset = {}; this.value = ""; this.disabled = false; this.checked = false;
    this.parentNode = null; this._text = ""; this._html = ""; this._handlers = {}; this._query = new Map();
  }
  set className(v) { this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c)); }
  get className() { return [...this.classList.set].join(" "); }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); }
  dispatchEvent(e) { (this._handlers[e.type] || []).forEach(fn => fn(e)); }
  focus() {}
  closest() { return this.parentNode || new El(); }
  scrollIntoView() {}
  set files(v) { this._files = v; }
  get files() { return this._files || []; }
  // <select>.options 派生自已 append 的子元素，保持与真实 DOM 一致。
  get options() { return this.children; }
  querySelector(sel) {
    if (!this._query.has(sel)) { const el = new El(); el.parentNode = this; el._selector = sel; this._query.set(sel, el); }
    return this._query.get(sel);
  }
  querySelectorAll(selector) {
    if(selector === '#qa-mode button') {
      if(!this._modeButtons)this._modeButtons=Array.from(this.innerHTML.matchAll(/data-mode="([^"]*)"/g),m=>{const b=new El('button');b.dataset.mode=m[1];return b;});
      return this._modeButtons;
    }
    return [];
  }
}
function makeDocument() {
  const byId = new Map();
  return {
    title: "",
    createElement: tag => new El(tag),
    getElementById(id) { if (!byId.has(id)) { byId.set(id, new El()); } return byId.get(id); },
    addEventListener() {},
    querySelector: () => new El(),
  };
}
function makeStorage() {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

/* ---------------- deferred fetch ---------------- */
let pending = [];
function fakeFetch(path, opts) {
  return new Promise((resolve, reject) => pending.push({ path, opts, resolve, reject }));
}
function takeCall(part) {
  const i = pending.findIndex(c => c.path.includes(part));
  assert.ok(i >= 0, `expected a pending request matching ${part}; pending=${pending.map(c => c.path).join(",")}`);
  return pending.splice(i, 1)[0];
}
function jsonResp(status, obj) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj };
}
function sseResp(frames) {
  let i = 0;
  const encoder = new TextEncoder();
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < frames.length ? { done: false, value: encoder.encode(frames[i++]) } : { done: true }) }) } };
}
function frame(obj) { return "data: " + JSON.stringify(obj) + "\r\n\r\n"; }
const flush = () => new Promise(r => setImmediate(r));

/* ---------------- boot the real assets in a vm ---------------- */
function boot() {
  // 每个测试用全新的请求队列：跨测试遗留的未决请求会让路径匹配串台。
  pending = [];
  const win = {};
  win.window = win;
  Object.assign(win, {
    document: makeDocument(), sessionStorage: makeStorage(), localStorage: makeStorage(),
    location: { hash: "#/materials", href: "http://127.0.0.1:18100/" },
    performance: { now: () => Date.now() },
    fetch: fakeFetch, console,
    TextDecoder, TextEncoder, atob, btoa, crypto: { randomUUID },
    FormData, File, Blob, URL, URLSearchParams,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, JSON, Math, Promise, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
  });
  win.addEventListener = () => {};
  win.removeEventListener = () => {};
  vm.createContext(win);
  for (const f of ["session.js", "app.js", "views.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ASSETS, f), "utf8"), win, { filename: f });
  }
  return win;
}
function setIdentity(w, email, token, tenant = "2") {
  w.App.S.profiles = [{ email, name: email, token, tenant_id: tenant, user_id: "u-" + email, expires_at: Math.floor(Date.now() / 1000) + 3600 }];
  w.App.S.activeEmail = email;
}

/* ---------------- 1. ask：跨身份迟到回答 + session 泄漏 + busy ---------------- */
test("a late answer from identity A never reaches identity B", async () => {
  const w = boot();
  const section = w.document.getElementById("view-qa");
  w.App.S.ui.view = "qa";
  w.Views.show("qa", section);
  const send = section.querySelector("#qa-send");
  const input = section.querySelector("#qa-q");

  setIdentity(w, "a@example.com", "token-a");
  // 新契约：问答范围必须先选（这里选「全部可用」），否则发送被禁用。
  w.App.S.qaScopeAll = true;
  w.Views.show("qa", section);
  input.value = "A 的问题";
  send.onclick();
  await flush();
  const callA = takeCall("/api/ask");
  assert.equal(JSON.parse(callA.opts.body).session_id, undefined);

  // 真实切换入口：B 上线（setActiveProfile 推进 epoch 并清空视图/状态）。
  setIdentity(w, "b@example.com", "token-b");
  w.App.setActiveProfile("b@example.com");
  await flush();
  // 新身份不继承旧范围：必须重新选择问答知识库范围。
  w.App.S.qaScopeAll = true;
  w.Views.show("qa", section);

  input.value = "B 的问题";
  send.onclick();
  await flush();
  const callB = takeCall("/api/ask");
  assert.equal(JSON.parse(callB.opts.body).session_id, undefined, "B 的首次提问不得携带 A 的 session_id");
  assert.equal(send.disabled, true, "B 的请求应在飞行中");

  // A 的回答此刻才到达：必须被整体丢弃。
  const sessionBefore = section.querySelector("#qa-session").textContent;
  callA.resolve(sseResp([frame({ type: "answer", text: "A 的回答", session_id: "sess-A" })]));
  await flush();
  assert.equal(send.disabled, true, "旧请求的 finally 不得关闭新请求的 busy");
  assert.equal(section.querySelector("#qa-session").textContent, sessionBefore, "A 的 session_id 不得写回");
  assert.equal(w.App.S.profiles[0].token, "token-b", "A 的迟到响应不得影响 B 的凭据");

  // B 正常完成后，新一轮提问携带 B 自己的 session。
  callB.resolve(sseResp([frame({ type: "answer", text: "B 的回答", session_id: "sess-B" })]));
  await flush();
  assert.equal(send.disabled, false);
  assert.match(section.querySelector("#qa-session").textContent, /^sess-B/);
  input.value = "B 第二问";
  send.onclick();
  await flush();
  const callB2 = takeCall("/api/ask");
  assert.equal(JSON.parse(callB2.opts.body).session_id, "sess-B");
  callB2.resolve(sseResp([frame({ type: "answer", text: "ok", session_id: "sess-B" })]));
  await flush();
});

/* ---------------- 2. 提交：迟到回执不得写回 ---------------- */
test("a late upload receipt from A never lands in B's materials view", async () => {
  const w = boot();
  const section = w.document.getElementById("view-materials");
  w.Views.show("materials", section);
  w.App.S.kbs = [{ id: "kb-1", name: "KB" }];
  w.Views.onSelectionChanged();
  setIdentity(w, "a@example.com", "token-a");

  const fileInput = section.querySelector("#m-file");
  fileInput.files = [new File(["x"], "note.md")];
  fileInput.onchange();
  section.querySelector("#m-kb").value = "kb-1";
  section.querySelector("#m-ingest").onclick();
  await flush();
  const submitCall = takeCall("/api/ingest");

  setIdentity(w, "b@example.com", "token-b");
  w.App.setActiveProfile("b@example.com");
  await flush();

  submitCall.resolve(jsonResp(200, { ok: true, result: {
    ingest_id: "i-a", upload_id: "up-a", document_id: "doc-a",
    file_name: "note.md", stage: "queued", queued: true } }));
  await flush();
  assert.ok(!/已提交/.test(section.querySelector("#m-import-status").textContent),
    "A 的完成态不得写入 B 的状态行");
  assert.equal(section.querySelector("#m-receipt").innerHTML, "", "A 的回执不得写入 B 的面板");
  assert.equal(w.App.S.trace.length, 0, "迟到响应不得写入轨迹");
});

/* ---------------- 3. 提交：迟到文档不得写回 ---------------- */
test("a late submit result from A never writes B's document state", async () => {
  const w = boot();
  const section = w.document.getElementById("view-materials");
  w.Views.show("materials", section);
  w.App.S.kbs = [{ id: "kb-1", name: "KB" }];
  w.Views.onSelectionChanged();
  setIdentity(w, "a@example.com", "token-a");
  section.querySelector("#m-kb").value = "kb-1";

  const fileInput = section.querySelector("#m-file");
  fileInput.files = [new File(["x"], "note.md")];
  fileInput.onchange();
  section.querySelector("#m-ingest").onclick();
  await flush();
  const submitCall = takeCall("/api/ingest");

  setIdentity(w, "b@example.com", "token-b");
  w.App.setActiveProfile("b@example.com");
  await flush();

  submitCall.resolve(jsonResp(200, { ok: true, result: {
    ingest_id: "i-a", upload_id: "up-1", document_id: "doc-A",
    file_name: "note.md", stage: "queued", queued: true } }));
  await flush();
  assert.equal(section.querySelector("#m-doc").textContent, "", "A 的 document id 不得写入 B 的面板");
  assert.equal(pending.filter(c => c.path.includes("/api/ingest_status")).length, 0,
    "A 的迟到结果不得触发 B 的状态轮询");
});

/* ---------------- 4. 清单：迟到 step/done 不得渲染 ---------------- */
test("late checklist steps and summary from A are dropped", async () => {
  const w = boot();
  // 清单已收进诊断页；它对「上传目标」知识库执行。
  const section = w.document.getElementById("view-bench");
  w.Views.show("bench", section);
  setIdentity(w, "a@example.com", "token-a");
  w.App.S.uploadTargetKbId = "kb-1";

  section.querySelector("#m-run-checklist").onclick();
  await flush();
  const checkCall = takeCall("/api/checklist");
  const tbody = section.querySelector("#m-checklist").querySelector("tbody");

  setIdentity(w, "b@example.com", "token-b");
  w.App.setActiveProfile("b@example.com");
  await flush();

  checkCall.resolve(sseResp([
    frame({ type: "step", tool: "read_document", status: "pass", latency_ms: 3, summary: "A 的结果" }),
    frame({ type: "done", summary: { pass: 1, fail: 0, skip: 0 } }),
  ]));
  await flush();
  assert.equal(tbody.children.length, 0, "迟到的清单步骤不得渲染");
  assert.equal(section.querySelector("#m-summary").textContent, "", "迟到的清单汇总不得写回");
});

/* ---------------- 5. 工具台：迟到结果不得写回状态行 ---------------- */
test("a late bench tool result never rewrites B's status line", async () => {
  const w = boot();
  const section = w.document.getElementById("view-bench");
  w.Views.show("bench", section);
  setIdentity(w, "a@example.com", "token-a");
  w.App.S.tools = [{ name: "list_knowledge_bases", description: "d", inputSchema: {}, destructive: false }];
  w.Views.show("bench", section);
  const list = section.querySelector("#b-list");
  const item = list.children.find(c => String(c.className).includes("tool-item"));
  assert.ok(item, "工具项应已渲染");
  item.onclick();
  await flush();

  const detail = section.querySelector("#b-detail");
  detail.querySelector("#b-run").onclick();
  await flush();
  const toolCall = takeCall("/api/tool");
  // 状态行此刻写着「运行中…（中文工具名）」；用实际值做基准，断言迟到的
  // 结果一个字符都不改它。
  const statusBefore = detail.querySelector("#b-status").textContent;

  setIdentity(w, "b@example.com", "token-b");
  w.App.setActiveProfile("b@example.com");
  await flush();

  toolCall.resolve(jsonResp(200, { ok: true, latency_ms: 4, result: { knowledge_bases: [] } }));
  await flush();
  assert.equal(detail.querySelector("#b-status").textContent, statusBefore, "迟到结果不得改写状态行");
  assert.equal(detail.querySelector("#b-result").children.length, 0, "迟到结果不得渲染响应面板");
});

/* ---------------- 6. 上传标识：换文件自动换 key + 冲突自动重试 ---------------- */
test("uploading a second file never reuses the previous idempotency key", async () => {
  const w = boot();
  const section = w.document.getElementById("view-materials");
  w.Views.show("materials", section);
  setIdentity(w, "a@example.com", "token-a");
  const fileInput = section.querySelector("#m-file");
  const idem = section.querySelector("#m-idem");

  fileInput.files = [new File([new Uint8Array([1])], "first.pdf", { type: "application/pdf" })];
  fileInput.onchange();
  const key1 = idem.value;
  assert.ok(key1, "首次选择文件后应有上传标识");

  fileInput.files = [new File([new Uint8Array([2])], "second.pdf", { type: "application/pdf" })];
  fileInput.onchange();
  assert.notEqual(idem.value, key1, "换文件必须换新标识，否则服务端按幂等契约拒绝第二份文件");
});

test("an idempotency conflict is retried once with a fresh key", async () => {
  const w = boot();
  const section = w.document.getElementById("view-materials");
  w.Views.show("materials", section);
  setIdentity(w, "a@example.com", "token-a");
  section.querySelector("#m-kb").value = "kb-1";
  const fileInput = section.querySelector("#m-file");
  fileInput.files = [new File([new Uint8Array([3])], "third.pdf", { type: "application/pdf" })];
  fileInput.onchange();

  const st = section.querySelector("#m-import-status");
  section.querySelector("#m-ingest").onclick();
  await flush();
  const first = takeCall("/api/ingest");
  const key1 = first.opts.headers["Idempotency-Key"];
  assert.ok(key1, "提交请求必须带 Idempotency-Key");

  // 服务端按幂等契约拒绝：同一标识配了不同字节。
  first.resolve(jsonResp(200, { ok: false, error: "this Idempotency-Key was already used for a different file or knowledge base", error_code: "IDEMPOTENCY_CONFLICT" }));
  await flush();
  const second = takeCall("/api/ingest");
  const key2 = second.opts.headers["Idempotency-Key"];
  assert.notEqual(key2, key1, "冲突后必须用新标识重试");
  second.resolve(jsonResp(200, { ok: true, result: {
    ingest_id: "i-1", upload_id: "u-1", document_id: "doc-1", file_name: "third.pdf",
    stage: "queued", queued: true, deduplicated: false } }));
  await flush();
  assert.ok(/已提交/.test(st.textContent), "重试成功后应显示提交回执：" + st.textContent);
  // 提交成功即开始轮询该文档的状态。
  takeCall("/api/ingest_status").resolve(jsonResp(200, { ok: true, result: {
    stage: "imported", phases: { upload: "imported", parse: "completed", index: "completed" },
    document: { parse_status: "completed", index_status: "completed", title: "third.pdf" } } }));
  await flush();
});

/* ---------------- 7. 资料页：刷新后能找回上次导入并继续看进度 ---------------- */
test("a refreshed page restores the last import and keeps polling it", async () => {
  const w = boot();
  const section = w.document.getElementById("view-materials");
  setIdentity(w, "a@example.com", "token-a");
  // 模拟「上次会话记录」：真实路径由提交成功时写进 sessionStorage。
  w.sessionStorage.setItem("wk.materials.last", JSON.stringify({
    email: "a@example.com", workspace: "2", engine: "__default__",
    receipt: { kb: "kb-1", ingest_id: "i-1", upload_id: "u-1", document_id: "doc-1",
               file_name: "青岚计划.pdf", file_size: 159000, stage: "queued" },
    doc: { id: "doc-1", title: "青岚计划.pdf" }, at: Date.now(),
  }));
  w.Views.show("materials", section);
  await flush();

  assert.equal(section.querySelector("#m-doc").textContent, "doc-1", "恢复后应显示上次的文档");
  assert.ok(/恢复上次导入记录/.test(section.querySelector("#m-import-status").textContent), "应提示这是恢复的记录");
  assert.equal(section.querySelector("#m-ingest").disabled, false, "恢复后提交按钮可用（可直接重试）");

  // 恢复后立刻续看状态：应发出一次 ingest_document.status 查询。
  const statusCall = takeCall("/api/ingest_status");
  statusCall.resolve(jsonResp(200, { ok: true, result: {
    stage: "staged", phases: { upload: "imported", parse: "running", index: "pending" },
    document: { parse_status: "running", index_status: "pending",
                applied_parser_engine: "anydoc",
                requested_parser_engine_rules: [{ file_types: ["pdf"], engine: "anydoc" }],
                file_type: "pdf" } } }));
  await flush();
  const panel = section.querySelector("#m-doc-status").innerHTML;
  assert.ok(/解析中/.test(panel), "进度面板应显示中文解析状态：" + panel.slice(0, 120));
  assert.ok(/anydoc/.test(panel), "面板应显示实际引擎");
});

test("a finished parse shows the chunk preview in the progress panel", async () => {
  const w = boot();
  const section = w.document.getElementById("view-materials");
  setIdentity(w, "a@example.com", "token-a");
  w.Views.show("materials", section);
  w.App.S.uploadTargetKbId = "kb-1";
  section.querySelector("#m-kb").value = "kb-1";
  const fileInput = section.querySelector("#m-file");
  fileInput.files = [new File([new Uint8Array([9])], "done.pdf", { type: "application/pdf" })];
  fileInput.onchange();
  section.querySelector("#m-ingest").onclick();
  await flush();
  takeCall("/api/ingest").resolve(jsonResp(200, { ok: true, result: {
    ingest_id: "i-9", upload_id: "u-9", document_id: "doc-9", file_name: "done.pdf",
    stage: "queued", queued: true, deduplicated: false } }));
  await flush();

  takeCall("/api/ingest_status").resolve(jsonResp(200, { ok: true, result: {
    stage: "imported", phases: { upload: "imported", parse: "completed", index: "completed" },
    document: { parse_status: "completed", index_status: "completed",
                applied_parser_engine: "default", file_type: "pdf" } } }));
  await flush();
  takeCall("/api/tool").resolve(jsonResp(200, { ok: true, result: { document: {
    total_chunks: 12, fetched_chunks: 1,
    chunks: [{ content: "青岚计划 QL-2026-417 负责人林澈" }],
  } } }));
  await flush();
  const panel = section.querySelector("#m-doc-status").innerHTML;
  assert.ok(/解析完成/.test(panel), "完成后应给出完成提示");
  assert.ok(/12/.test(panel), "应显示分块数");
  assert.ok(/林澈/.test(panel), "应显示解析出的原文预览");
});

/* ---------------- 8. 工具示例：用真实 id 填参数 ---------------- */
test("a tool example fills real ids from the live workspace", async () => {
  const w = boot();
  const section = w.document.getElementById("view-bench");
  w.App.S.ui.view = "bench";
  setIdentity(w, "a@example.com", "token-a");
  w.App.S.kbs = [{ id: "kb-1", name: "验收库", type: "document", capability_flags: {} }];
  w.App.S.uploadTargetKbId = "kb-1";
  w.App.S.tools = [{
    name: "read_document", description: "d", destructive: false,
    inputSchema: { type: "object", required: ["action"],
                   properties: { action: { type: "string", enum: ["list", "read"] },
                                 knowledge_id: { type: "string", description: "Document id" },
                                 limit: { type: "number", description: "chunks" } } },
  }];
  w.Views.show("bench", section);
  const item = section.querySelector("#b-list").children.find(c => String(c.className).includes("tool-item"));
  item.onclick();
  await flush();

  const detail = section.querySelector("#b-detail");
  detail.querySelector("#b-example").onclick();
  await flush();
  // 示例先解析出「最近一篇文档」，再把它填进 knowledge_id。
  const lookup = takeCall("/api/tool");
  const lookupBody = JSON.parse(lookup.opts.body);
  assert.equal(lookupBody.name, "read_document");
  assert.equal(lookupBody.arguments.action, "list");
  assert.equal(lookupBody.arguments.knowledge_base_id, "kb-1");
  lookup.resolve(jsonResp(200, { ok: true, result: {
    source_type: "document", knowledge_base_id: "kb-1",
    documents: { total: 2, documents: [
      { id: "doc-42", title: "青岚计划.pdf", parse_status: "completed" },
      { id: "doc-41", title: "旧文档.md", parse_status: "completed" },
    ] } } }));
  await flush();

  assert.equal(w.App.S.tools.length, 1);
  const filled = detail.querySelector("#b-form");
  const labels = filled.children.filter(c => String(c.tagName) === "label");
  const target = labels.find(l => String(l.innerHTML).includes("knowledge_id"));
  assert.ok(target, "表单应渲染出 knowledge_id 字段");
  assert.equal(target.children[0].value, "doc-42", "示例应填入真实文档 id");
  assert.equal(labels.find(l => String(l.innerHTML).includes("action")).children[0].value, "read",
               "示例应把 action 填成 read");
  assert.ok(/青岚计划/.test(detail.querySelector("#b-example-note").textContent), "示例说明应指出用的是哪篇文档");
});

/* ---------------- 9. 问答示例问题：一点即填入 ---------------- */
test("the QA page offers example questions that fill the input", async () => {
  const w = boot();
  const section = w.document.getElementById("view-qa");
  w.App.S.ui.view = "qa";
  setIdentity(w, "a@example.com", "token-a");
  w.App.S.qaKbIds = ["kb-a"];
  w.Views.show("qa", section);

  // 极简 DOM 不解析 HTML，示例 chips 是代码 appendChild 进来的子元素。
  const chips = section.querySelector("#qa-examples").children;
  assert.ok(chips.length >= 3, "应提供几个示例问题：" + chips.length);
  chips[1].onclick();
  assert.equal(section.querySelector("#qa-q").value, chips[1].textContent, "点击示例应填入问题");
});

/* ---------------- 10. KB/工具刷新：迟到列表不得写回 ---------------- */
test("a late knowledge-base list from A never repopulates B's state", async () => {
  const w = boot();
  setIdentity(w, "a@example.com", "token-a");
  const inFlight = w.App.loadKbs();
  await flush();
  const kbCall = takeCall("/api/kbs");

  setIdentity(w, "b@example.com", "token-b");
  w.App.setActiveProfile("b@example.com");
  await flush();
  assert.deepEqual([...w.App.S.kbs], []);

  kbCall.resolve(jsonResp(200, { ok: true, result: { knowledge_bases: [{ id: "kb-A", name: "A 的库" }] } }));
  await flush();
  assert.deepEqual([...w.App.S.kbs], [], "A 的库列表不得写入 B 的状态");
  await inFlight;
});

/* ---------------- 7. 401 失效：推进 epoch 并清空身份相关状态 ---------------- */
test("a 401 on the current token invalidates it and advances the epoch", async () => {
  const w = boot();
  setIdentity(w, "a@example.com", "token-a");
  const before = w.App.captureIdentityEpoch();
  const inFlight = w.App.loadKbs();
  await flush();
  takeCall("/api/kbs").resolve(jsonResp(401, { error: "unauthorized" }));
  await flush();
  await inFlight;
  assert.equal(w.App.captureIdentityEpoch(), before + 1, "失效必须推进 epoch");
  assert.equal(w.App.S.profiles.length, 0);
  assert.equal(w.App.S.activeEmail, "");
  assert.equal(w.App.S.trace.length, 0, "失效后旧轨迹不得残留");
});

/* ---------------- 8. 迟到 401：不得废除替换后的新 Token ---------------- */
test("a late 401 from a retired token never invalidates the replacement", async () => {
  const w = boot();
  setIdentity(w, "a@example.com", "token-a");
  const inFlight = w.App.loadKbs();
  await flush();
  const staleCall = takeCall("/api/kbs");

  setIdentity(w, "b@example.com", "token-b");
  w.App.setActiveProfile("b@example.com");
  await flush();

  staleCall.resolve(jsonResp(401, { error: "unauthorized" }));
  await flush();
  await inFlight;
  assert.equal(w.App.S.profiles.length, 1, "B 的凭据必须保留");
  assert.equal(w.App.S.profiles[0].token, "token-b");
  assert.equal(w.App.S.activeEmail, "b@example.com");
});

/* ---------------- 9. 问答范围切换：会话与旧请求隔离（P0-1） ---------------- */
test("a QA scope change starts a new session and drops the previous range's answers", async () => {
  const w = boot();
  const section = w.document.getElementById("view-qa");
  w.App.S.ui.view = "qa";
  w.Views.show("qa", section);
  const send = section.querySelector("#qa-send");
  const input = section.querySelector("#qa-q");
  setIdentity(w, "a@example.com", "token-a");
  w.App.S.qaKbIds = ["kb-a"];
  w.Views.show("qa", section);

  // 范围 A 的提问在飞行中
  input.value = "A 范围的问题";
  send.onclick();
  await flush();
  const callA = takeCall("/api/ask");
  assert.equal(send.disabled, true, "提问期间发送应禁用");

  // 切换到范围 B：必须开新会话、旧回答不得写回
  w.App.S.qaKbIds = ["kb-b"];
  w.App.advanceQaEpoch();
  await flush();
  assert.equal(section.querySelector("#qa-session").textContent, "–", "范围变化必须开新会话");
  assert.equal(send.disabled, false, "范围变化后应可再次提问");

  callA.resolve(sseResp([frame({ type: "answer", text: "A 范围的回答", session_id: "sess-A" })]));
  await flush();
  assert.equal(section.querySelector("#qa-session").textContent, "–", "旧范围的回答不得写回新会话");

  // 新范围的提问不得携带旧 session_id
  input.value = "B 范围的问题";
  send.onclick();
  await flush();
  const callB = takeCall("/api/ask");
  assert.equal(JSON.parse(callB.opts.body).session_id, undefined, "新范围不得继承旧 session_id");
  assert.equal(callB.opts.headers["X-WeKnora-Knowledge-Base-Ids"], "kb-b", "请求头必须带新范围");
  callB.resolve(sseResp([frame({ type: "answer", text: "B 的回答", session_id: "sess-B" })]));
  await flush();
});

/* ---------------- 10. 未选范围时禁止发送（空选择语义） ---------------- */
test("sending is disabled until a QA knowledge-base scope is chosen", async () => {
  const w = boot();
  const section = w.document.getElementById("view-qa");
  w.App.S.ui.view = "qa";
  w.Views.show("qa", section);
  setIdentity(w, "a@example.com", "token-a");
  w.Views.show("qa", section);
  const send = section.querySelector("#qa-send");

  assert.equal(send.disabled, true, "未选范围必须禁用发送");
  send.onclick();
  await flush();
  assert.equal(pending.filter(c => c.path.includes("/api/ask")).length, 0, "未选范围不得发出 ask");

  // 显式「全部可用」是唯一表示「不收窄」的方式
  w.App.S.qaScopeAll = true;
  w.Views.show("qa", section);
  assert.equal(send.disabled, false, "选择全部可用后应可提问");
});

/* ---------------- 11. 布尔字段：三态且能显式关闭默认 true ---------------- */
test("boolean fields are tri-state and can explicitly override a true default", async () => {
  const w = boot();
  const section = w.document.getElementById("view-bench");
  w.App.S.ui.view = "bench";
  setIdentity(w, "a@example.com", "token-a");
  w.App.S.tools = [{
    name: "knowledge_base", description: "d", destructive: false,
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["create"] },
      name: { type: "string" },
      enable_keyword: { type: "boolean", description: "关键词索引" },
    } },
  }];
  w.Views.show("bench", section);
  const item = section.querySelector("#b-list").children.find(c => String(c.className).includes("tool-item"));
  item.onclick();
  await flush();

  const detail = section.querySelector("#b-detail");
  const form = detail.querySelector("#b-form");
  const labels = form.children.filter(c => String(c.tagName) === "label");
  const boolLabel = labels.find(l => String(l.innerHTML).includes("enable_keyword"));
  const select = boolLabel.children[0];
  assert.equal(select.tagName, "select", "布尔字段应是下拉而不是复选框");
  assert.equal(select.children.length, 3, "应提供 不传 / true / false 三种选择");
  assert.equal(select.children[0].value, "", "第一项是不传");
  assert.match(select.children[0].textContent, /默认：true/);

  labels.find(l => String(l.innerHTML).includes(">name<")).children[0].value = "测试库";
  labels.find(l => String(l.innerHTML).includes(">action<")).children[0].value = "create";
  select.value = "false";
  detail.querySelector("#b-run").onclick();
  await flush();
  const call = takeCall("/api/tool");
  const args = JSON.parse(call.opts.body).arguments;
  assert.equal(args.enable_keyword, false, "勾选 false 必须显式发送 false，而不是省略");
  call.resolve(jsonResp(200, { ok: true, result: {} }));
  await flush();

  select.value = "";
  detail.querySelector("#b-run").onclick();
  await flush();
  const call2 = takeCall("/api/tool");
  assert.equal("enable_keyword" in JSON.parse(call2.opts.body).arguments, false,
               "选择不传时应省略字段，让服务端使用默认值");
  call2.resolve(jsonResp(200, { ok: true, result: {} }));
  await flush();
});

/* ---------------- 12. 表单 ↔ JSON 往返保留已填内容 ---------------- */
test("switching between the form and JSON keeps both directions' values", async () => {
  const w = boot();
  const section = w.document.getElementById("view-bench");
  w.App.S.ui.view = "bench";
  setIdentity(w, "a@example.com", "token-a");
  w.App.S.tools = [{
    name: "knowledge_base", description: "d", destructive: false,
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["create"] },
      name: { type: "string" },
      enable_keyword: { type: "boolean", default: true },
    } },
  }];
  w.Views.show("bench", section);
  const item = section.querySelector("#b-list").children.find(c => String(c.className).includes("tool-item"));
  item.onclick();
  await flush();

  const detail = section.querySelector("#b-detail");
  const form = detail.querySelector("#b-form");
  const labels = () => form.children.filter(c => String(c.tagName) === "label");
  const boolSelect = () => labels().find(l => String(l.innerHTML).includes("enable_keyword")).children[0];
  labels().find(l => String(l.innerHTML).includes(">name<")).children[0].value = "往返测试库";
  labels().find(l => String(l.innerHTML).includes(">action<")).children[0].value = "create";
  boolSelect().value = "false";

  const modes = detail.querySelector("#b-mode").children;
  assert.equal(modes.length, 2, "应有表单 / JSON 两个模式按钮");
  modes[1].onclick();  // 表单 -> JSON
  const jsonBox = detail.querySelector("#b-json-text");
  const fromForm = JSON.parse(jsonBox.value);
  assert.equal(fromForm.name, "往返测试库");
  assert.equal(fromForm.enable_keyword, false);

  // 在 JSON 里加一个 schema 之外的键，切回表单后再运行，它也必须保留。
  fromForm.custom_flag = 7;
  jsonBox.value = JSON.stringify(fromForm);
  modes[0].onclick();  // JSON -> 表单
  const fresh = labels().slice(-3);
  assert.equal(fresh.find(l => String(l.innerHTML).includes(">name<")).children[0].value,
               "往返测试库", "切回表单不应清空字符串字段");
  assert.equal(fresh.find(l => String(l.innerHTML).includes("enable_keyword")).children[0].value,
               "false", "切回表单应恢复布尔三态");

  detail.querySelector("#b-run").onclick();
  await flush();
  const call = takeCall("/api/tool");
  const args = JSON.parse(call.opts.body).arguments;
  assert.equal(args.name, "往返测试库");
  assert.equal(args.enable_keyword, false);
  assert.equal(args.custom_flag, 7, "schema 外的键不得在表单往返中丢失");
  call.resolve(jsonResp(200, { ok: true, result: {} }));
  await flush();
});

/* ---------------- 13. 文档管理：目录 + 正文 + 文档内检索 ---------------- */
test("the document page lists a library and reads chunks through MCP", async () => {
  const w = boot();
  setIdentity(w, "a@example.com", "token-a");
  w.App.S.kbs = [{ id: "kb-1", name: "验收库", type: "document" }];
  w.App.S.uploadTargetKbId = "kb-1";
  const section = w.document.getElementById("view-docs");
  w.App.S.ui.view = "docs";
  w.Views.show("docs", section);
  await flush();

  const listCall = takeCall("/api/documents");
  assert.match(listCall.path, /knowledge_base_id=kb-1/);
  assert.match(listCall.path, /page=1/);
  assert.match(listCall.path, /page_size=10/);
  listCall.resolve(jsonResp(200, { ok: true, knowledge_base_id: "kb-1", total: 2,
    page: 1, page_size: 10, documents: [
      { id: "doc-1", title: "青岚计划.pdf", parse_status: "completed", file_type: "pdf" },
      { id: "doc-2", title: "旧文档.md", parse_status: "failed", file_type: "md" },
    ] }));
  await flush();

  const readCall = takeCall("/api/document");
  assert.match(readCall.path, /knowledge_id=doc-1/);
  assert.match(readCall.path, /offset=0/);
  readCall.resolve(jsonResp(200, { ok: true, knowledge_base_id: "kb-1",
    document: { knowledge_id: "doc-1", title: "青岚计划.pdf", parse_status: "completed",
                chunk_count: 3, file_type: "pdf" },
    chunks: [{ chunk_id: "c-1", chunk_index: 0, content: "负责人林澈。" }],
    total_chunks: 3, fetched_chunks: 1, offset: 0, page_size: 8,
    query: "", match_count: null, truncated: true, next_offset: 1 }));
  await flush();

  const reader = section.querySelector("#d-reader");
  assert.match(reader.innerHTML, /青岚计划\.pdf/);
  assert.match(reader.innerHTML, /负责人林澈/);
  assert.match(reader.innerHTML, /共 3 块/);
  assert.match(reader.innerHTML, /下一组/);
  const next = reader.querySelector("#d-read-next");
  assert.equal(next.disabled, false, "有 next_offset 时下一组应可点");

  // 文档内检索：query 必须进 URL，结果按命中/上下文渲染。
  reader.querySelector("#d-query").value = "林澈";
  reader.querySelector("#d-query-run").onclick();
  await flush();
  const searchCall = takeCall("/api/document");
  assert.match(searchCall.path, /query=%E6%9E%97%E6%BE%88/);
  searchCall.resolve(jsonResp(200, { ok: true, knowledge_base_id: "kb-1",
    document: { knowledge_id: "doc-1", title: "青岚计划.pdf", parse_status: "completed",
                chunk_count: 3 },
    chunks: [{ chunk_id: "c-1", chunk_index: 0, role: "match", content: "负责人林澈。",
               match_snippet: "林澈" }],
    total_chunks: 3, fetched_chunks: 1, offset: 0, page_size: 8,
    query: "林澈", match_count: 1, truncated: false, next_offset: null }));
  await flush();
  assert.match(section.querySelector("#d-reader").innerHTML, /命中/);
  assert.match(section.querySelector("#d-reader").innerHTML, /林澈/);
});


test("QA specified agent sends agent_id exclusively and changing agents discards late sessions", async()=>{
  const w=boot();setIdentity(w,'a@example.com','token-a');w.App.S.qaScopeAll=true;
  w.AgentWorkspace={available:()=>true,list:async()=>[{id:'agent-a',name:'Agent A'},{id:'agent-b',name:'Agent B'}]};
  const section=w.document.getElementById('view-qa');w.Views.show('qa',section);await flush();
  const agentMode=section.querySelectorAll('#qa-mode button').find(b=>b.dataset.mode==='agent');assert.ok(agentMode);agentMode.onclick();await flush();
  const picker=section.querySelector('#qa-agent');picker.value='agent-a';picker.onchange();
  w.App.S.qaScopeAll=false;w.App.S.qaKbIds=['kb-selected'];
  section.querySelector('#qa-q').value='Question A';section.querySelector('#qa-send').onclick();await flush();
  const first=takeCall('/api/ask'),args=JSON.parse(first.opts.body);assert.equal(args.agent_id,'agent-a');assert.equal(args.mode,undefined);assert.equal(args.profile_id,undefined);assert.deepEqual(args.knowledge_base_ids,['kb-selected']);
  const before=w.App.captureQaEpoch();picker.value='agent-b';picker.onchange();assert.ok(w.App.captureQaEpoch()>before);
  section.querySelector('#qa-q').value='Question B';section.querySelector('#qa-send').onclick();await flush();
  const second=takeCall('/api/ask');assert.equal(JSON.parse(second.opts.body).agent_id,'agent-b');assert.equal(JSON.parse(second.opts.body).session_id,undefined);
  first.resolve(sseResp([frame({type:'answer',text:'OLD',session_id:'old-session'})]));await flush();
  assert.equal(section.querySelector('#qa-send').disabled,true);assert.doesNotMatch(section.querySelector('#qa-session').textContent,/old-session/);
  second.resolve(sseResp([frame({type:'answer',text:'NEW',session_id:'new-session'})]));await flush();assert.match(section.querySelector('#qa-session').textContent,/new-session/);
  section.querySelectorAll('#qa-mode button').find(b=>b.dataset.mode==='quick-answer').onclick();
  section.querySelector('#qa-q').value='Quick';section.querySelector('#qa-send').onclick();await flush();
  const quick=JSON.parse(takeCall('/api/ask').opts.body);assert.equal(quick.mode,'quick-answer');assert.equal(quick.agent_id,undefined);assert.equal(quick.session_id,undefined);
});

test("QA missing agent tool blocks specified-agent questions and identity reset clears selection",async()=>{
  const w=boot();setIdentity(w,'a@example.com','token-a');w.App.S.qaScopeAll=true;w.App.S.qaMode='agent';w.App.S.qaAgentId='old-agent';
  const section=w.document.getElementById('view-qa');w.Views.show('qa',section);await flush();
  assert.equal(section.querySelector('#qa-send').disabled,true);assert.match(section.querySelector('#qa-agent-status').textContent,/未提供/);
  w.App.setActiveProfile('a@example.com');assert.equal(w.App.S.qaAgentId,'');
});

test('editing the selected native agent invalidates its bound QA session and suppresses the old stream',async()=>{
  const w=boot();setIdentity(w,'a@example.com','token-a');w.App.S.qaScopeAll=true;w.App.S.qaMode='agent';w.App.S.qaAgentId='same-agent';
  let knowledgeBases=['kb-a'];
  w.AgentWorkspace={available:()=>true,list:async()=>[{id:'same-agent',name:'Agent',config:{kb_selection_mode:'selected',knowledge_bases:knowledgeBases}}]};
  const section=w.document.getElementById('view-qa');w.Views.show('qa',section);await flush();
  const ask=async question=>{section.querySelector('#qa-q').value=question;section.querySelector('#qa-send').onclick();await flush();return takeCall('/api/ask');};
  const first=await ask('Before edit');first.resolve(sseResp([frame({type:'answer',text:'Before',session_id:'old-bound-session'})]));await flush();
  const oldStream=await ask('In flight before edit');assert.equal(JSON.parse(oldStream.opts.body).session_id,'old-bound-session');
  const epoch=w.App.captureQaEpoch();knowledgeBases=['kb-b'];w.Views.onAgentsChanged();await flush();
  assert.ok(w.App.captureQaEpoch()>epoch);assert.equal(section.querySelector('#qa-session').textContent,'–');assert.equal(w.App.S.qaAgentId,'same-agent');
  const fresh=await ask('After edit');const payload=JSON.parse(fresh.opts.body);assert.equal(payload.agent_id,'same-agent');assert.equal(payload.session_id,undefined);
  oldStream.resolve(sseResp([frame({type:'answer',text:'Obsolete',session_id:'old-bound-session'})]));await flush();
  assert.equal(section.querySelector('#qa-send').disabled,true);assert.equal(section.querySelector('#qa-session').textContent,'–');
  fresh.resolve(sseResp([frame({type:'answer',text:'Current',session_id:'new-bound-session'})]));await flush();
  assert.match(section.querySelector('#qa-session').textContent,/new-bound/);
});

for(const mode of ['quick-answer','smart-reasoning'])test('agent configuration notifications preserve unrelated '+mode+' sessions',async()=>{
  const w=boot();setIdentity(w,'a@example.com','token-a');w.App.S.qaScopeAll=true;w.App.S.qaMode=mode;
  w.AgentWorkspace={available:()=>true,list:async()=>[{id:'agent',name:'Agent'}]};
  const section=w.document.getElementById('view-qa');w.Views.show('qa',section);await flush();
  section.querySelector('#qa-q').value='Before';section.querySelector('#qa-send').onclick();await flush();
  takeCall('/api/ask').resolve(sseResp([frame({type:'answer',text:'Answer',session_id:'mode-session'})]));await flush();
  const epoch=w.App.captureQaEpoch();w.Views.onAgentsChanged();await flush();assert.equal(w.App.captureQaEpoch(),epoch);
  section.querySelector('#qa-q').value='After';section.querySelector('#qa-send').onclick();await flush();
  const payload=JSON.parse(takeCall('/api/ask').opts.body);assert.equal(payload.mode,mode);assert.equal(payload.session_id,'mode-session');
});

test('opening QA from agent detail updates an already mounted picker while preserving the chosen KB scope',async()=>{
  const w=boot();setIdentity(w,'a@example.com','token-a');w.App.S.qaScopeAll=false;w.App.S.qaKbIds=['kb-existing'];w.App.S.qaMode='quick-answer';
  w.AgentWorkspace={available:()=>true,list:async()=>[{id:'chosen-agent',name:'Chosen'}]};
  const section=w.document.getElementById('view-qa');w.Views.show('qa',section);await flush();
  section.querySelector('#qa-q').value='First';section.querySelector('#qa-send').onclick();await flush();
  takeCall('/api/ask').resolve(sseResp([frame({type:'answer',text:'Old answer',session_id:'old-quick-session'})]));await flush();
  const epoch=w.App.captureQaEpoch();w.Views.openQaForAgent('chosen-agent');await flush();
  assert.ok(w.App.captureQaEpoch()>epoch);assert.equal(w.App.S.qaMode,'agent');assert.equal(w.App.S.qaAgentId,'chosen-agent');
  assert.deepEqual(Array.from(w.App.S.qaKbIds),['kb-existing']);assert.equal(w.App.S.qaScopeAll,false);assert.equal(w.location.hash,'#/qa');
  assert.equal(section.querySelector('#qa-agent').value,'chosen-agent');assert.equal(section.querySelector('#qa-agent-picker').hidden,false);
  assert.equal(section.querySelectorAll('#qa-mode button').find(b=>b.dataset.mode==='agent').classList.contains('on'),true);
  assert.equal(section.querySelectorAll('#qa-mode button').find(b=>b.dataset.mode==='quick-answer').classList.contains('on'),false);
  section.querySelector('#qa-q').value='Agent question';section.querySelector('#qa-send').onclick();await flush();
  const payload=JSON.parse(takeCall('/api/ask').opts.body);assert.equal(payload.agent_id,'chosen-agent');assert.equal(payload.session_id,undefined);assert.deepEqual(payload.knowledge_base_ids,['kb-existing']);
});

for(const [responseId,label] of [['actual-agent','Actual Name'],['unlisted-agent','unlisted-agent']])test('QA answer identifies the response native agent as '+label,async()=>{
  const w=boot();setIdentity(w,'a@example.com','token-a');w.App.S.qaScopeAll=true;w.App.S.qaMode='agent';w.App.S.qaAgentId='requested-agent';
  w.AgentWorkspace={available:()=>true,list:async()=>[{id:'requested-agent',name:'Requested Name'},{id:'actual-agent',name:'Actual Name'}]};
  const section=w.document.getElementById('view-qa');w.Views.show('qa',section);await flush();
  section.querySelector('#qa-q').value='Question';section.querySelector('#qa-send').onclick();await flush();
  takeCall('/api/ask').resolve(sseResp([frame({type:'answer',text:'Answer',agent_id:responseId,mode:'smart-reasoning',knowledge_base_ids:['kb'],session_id:'session'})]));await flush();
  const ai=section.querySelector('#qa-msgs').children.filter(child=>child.classList.contains('ai')).pop();
  const badge=ai.querySelector('.refs').children[0];assert.match(badge.textContent,new RegExp('智能体 '+label));assert.match(badge.textContent,/smart-reasoning/);assert.match(badge.textContent,/范围 1 库/);
});
