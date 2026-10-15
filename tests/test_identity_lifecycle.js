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
  querySelectorAll() { return []; }
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
    FormData, File, Blob, URL,
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

/* ---------------- 2. 上传：迟到回执不得写回 ---------------- */
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
  section.querySelector("#m-upload").onclick();
  await flush();
  const uploadCall = takeCall("/api/upload");

  setIdentity(w, "b@example.com", "token-b");
  w.App.setActiveProfile("b@example.com");
  await flush();

  uploadCall.resolve(jsonResp(200, { ok: true, result: { upload_id: "up-a", file_name: "note.md", file_size: 1, sha256: "ab" } }));
  await flush();
  assert.notEqual(section.querySelector("#m-upload-status").textContent, "上传成功",
    "A 的完成态不得写入 B 的状态行");
  assert.equal(section.querySelector("#m-receipt").innerHTML, "", "A 的回执不得写入 B 的面板");
  assert.equal(w.App.S.trace.length, 0, "迟到响应不得写入轨迹");
});

/* ---------------- 3. 导入：迟到文档不得写回 ---------------- */
test("a late import result from A never writes B's document state", async () => {
  const w = boot();
  const section = w.document.getElementById("view-materials");
  w.Views.show("materials", section);
  w.App.S.kbs = [{ id: "kb-1", name: "KB" }];
  w.Views.onSelectionChanged();
  setIdentity(w, "a@example.com", "token-a");
  section.querySelector("#m-kb").value = "kb-1";

  // 先完成一次上传，让 M.receipt 就绪（同一身份）。
  const fileInput = section.querySelector("#m-file");
  fileInput.files = [new File(["x"], "note.md")];
  fileInput.onchange();
  section.querySelector("#m-upload").onclick();
  await flush();
  takeCall("/api/upload").resolve(jsonResp(200, { ok: true, result: { upload_id: "up-1", file_name: "note.md", file_size: 1, sha256: "ab" } }));
  await flush();
  assert.equal(section.querySelector("#m-import").disabled, false);

  section.querySelector("#m-import").onclick();
  await flush();
  const importCall = takeCall("/api/import");

  setIdentity(w, "b@example.com", "token-b");
  w.App.setActiveProfile("b@example.com");
  await flush();

  importCall.resolve(jsonResp(200, { ok: true, result: { document: { id: "doc-A", title: "A 的文档" }, queued: true } }));
  await flush();
  assert.equal(section.querySelector("#m-doc").textContent, "", "A 的 document id 不得写入 B 的面板");
  assert.equal(section.querySelector("#m-op-id").value, "", "写工具输入不得被 A 的结果预填");
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

  const st = section.querySelector("#m-upload-status");
  section.querySelector("#m-upload").onclick();
  await flush();
  const first = takeCall("/api/upload");
  const key1 = first.opts.headers["Idempotency-Key"];
  assert.ok(key1, "上传请求必须带 Idempotency-Key");

  // 服务端按幂等契约拒绝：同一标识配了不同字节。
  first.resolve(jsonResp(200, { ok: false, error: "this Idempotency-Key was already used for a different file or knowledge base", error_code: "IDEMPOTENCY_CONFLICT" }));
  await flush();
  const second = takeCall("/api/upload");
  const key2 = second.opts.headers["Idempotency-Key"];
  assert.notEqual(key2, key1, "冲突后必须用新标识重试");
  second.resolve(jsonResp(200, { ok: true, result: { upload_id: "u-1", file_name: "third.pdf" } }));
  await flush();
  assert.equal(st.textContent, "上传成功");
  assert.equal(section.querySelector("#m-import").disabled, false, "重试成功后导入按钮应可用");
});

/* ---------------- 7. 资料页：刷新后能找回上次导入并继续看进度 ---------------- */
test("a refreshed page restores the last import and keeps polling it", async () => {
  const w = boot();
  const section = w.document.getElementById("view-materials");
  setIdentity(w, "a@example.com", "token-a");
  // 模拟「上次会话记录」：真实路径由上传/导入成功时写进 sessionStorage。
  w.sessionStorage.setItem("wk.materials.last", JSON.stringify({
    email: "a@example.com", workspace: "2", engine: "__default__",
    receipt: { channel: "tool", kb: "kb-1", upload_id: "u-1", file_name: "青岚计划.pdf", file_size: 159000, sha256: "abc" },
    doc: { id: "doc-1", title: "青岚计划.pdf" }, at: Date.now(),
  }));
  w.Views.show("materials", section);
  await flush();

  assert.equal(section.querySelector("#m-doc").textContent, "doc-1", "恢复后应显示上次的文档");
  assert.ok(/恢复上次导入记录/.test(section.querySelector("#m-import-status").textContent), "应提示这是恢复的记录");
  assert.equal(section.querySelector("#m-import").disabled, false, "恢复后导入按钮可用（可直接重试）");

  // 恢复后立刻续看状态：应发出一次 document_status 查询。
  const statusCall = takeCall("/api/document_status");
  statusCall.resolve(jsonResp(200, { ok: true, result: { status: {
    parse_status: "running", index_status: "pending", applied_parser_engine: "anydoc",
    requested_parser_engine_rules: [{ file_types: ["pdf"], engine: "anydoc" }], file_type: "pdf",
  } } }));
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
  section.querySelector("#m-upload").onclick();
  await flush();
  takeCall("/api/upload").resolve(jsonResp(200, { ok: true, result: { upload_id: "u-9", file_name: "done.pdf" } }));
  await flush();
  section.querySelector("#m-import").onclick();
  await flush();
  takeCall("/api/import").resolve(jsonResp(200, { ok: true, result: { queued: true, deduplicated: false, document: { id: "doc-9", title: "done.pdf" } } }));
  await flush();

  takeCall("/api/document_status").resolve(jsonResp(200, { ok: true, result: { status: {
    parse_status: "completed", index_status: "completed", applied_parser_engine: "default", file_type: "pdf",
  } } }));
  await flush();
  takeCall("/api/tool").resolve(jsonResp(200, { ok: true, result: {
    total_chunks: 12, fetched_chunks: 1,
    chunks: [{ content: "青岚计划 QL-2026-417 负责人林澈" }],
  } }));
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
    name: "get_document_status", description: "d", destructive: false,
    inputSchema: { type: "object", required: ["knowledge_id"],
                   properties: { knowledge_id: { type: "string", description: "Document id" } } },
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
  assert.equal(lookupBody.name, "list_documents");
  assert.equal(lookupBody.arguments.knowledge_base_id, "kb-1");
  lookup.resolve(jsonResp(200, { ok: true, result: { documents: [
    { id: "doc-42", title: "青岚计划.pdf", parse_status: "completed" },
    { id: "doc-41", title: "旧文档.md", parse_status: "completed" },
  ] } }));
  await flush();

  assert.equal(w.App.S.tools.length, 1);
  const filled = detail.querySelector("#b-form");
  const input = filled.children.find(c => String(c.tagName) === "label");
  assert.ok(input, "表单应渲染出字段");
  assert.equal(input.children[0].value, "doc-42", "示例应填入真实文档 id");
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
