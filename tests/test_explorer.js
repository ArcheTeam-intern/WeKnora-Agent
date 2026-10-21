"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = path.join(__dirname, "../web/assets/explorer.js");
const lib = fs.existsSync(source) ? require(source) : {};
const need = name => { assert.equal(typeof lib[name], "function", `${name} must implement the product MCP interface`); return lib[name]; };

test("search mode options use the published MCP enum", () => {
  assert.deepEqual(lib.searchModes?.map(mode => mode.value), ["hybrid", "semantic", "keyword"]);
});

test("partial wiki and graph failures keep evidence and report source errors", () => {
  const result = need("normalizeSearch")({ sources: ["wiki", "graph"], results: {
    wiki: { content: '<page><link>[[topic|Topic]]</link><summary>Summary</summary><match_snippet>Exact hit</match_snippet></page><errors>KB B unavailable</errors>' },
    graph: { data: { results: [{ knowledge_base_id: "graph-b", content: "hit" }], errors: ["KB C unavailable"] } },
  } });
  assert.equal(result.partial, true);
  assert.match(result.groups[0].error, /KB B unavailable/);
  assert.equal(result.groups[0].items[0].content, "Exact hit");
  assert.match(result.groups[1].error, /KB C unavailable/);
  assert.equal(result.groups[1].items.length, 1);
});

test("source navigation uses hit libraries then enabled selected libraries", () => {
  const fn = need("sourceLibraries");
  const kbs = [{id: "a", capability_flags: {graph: false}}, {id: "b", capability_flags: {graph: true}}];
  assert.deepEqual(fn({source: "graph", items: [{knowledge_base_id: "b"}], block: {}}, ["a", "b"], kbs), ["b"]);
  assert.deepEqual(fn({source: "graph", items: [], block: {}}, ["a", "b"], kbs), ["b"]);
});

test("product request uses the existing five-tool MCP proxy and its own KB scope", async () => {
  const calls = [];
  const app = {
    captureIdentityEpoch: () => 1, isCurrentIdentityEpoch: e => e === 1,
    mcpHeaders: o => ({ scope: o.kbIds.join(",") }),
    api: async (url, options) => { calls.push({ url, options }); return { ok: true, data: { ok: true, result: { groups: [] } } }; },
  };
  const explorer = need("createExplorer")(app);
  const result = await explorer.call("read_document", { action: "list", source_type: "wiki", knowledge_base_id: "wiki-kb" }, ["wiki-kb"]);
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "/api/tool");
  assert.equal(calls[0].options.json.name, "read_document");
  assert.equal(calls[0].options.json.arguments.source_type, "wiki");
  assert.equal(calls[0].options.headers.scope, "wiki-kb");
});

test("identity changes invalidate a completed product request", async () => {
  let epoch = 1, release;
  const app = { captureIdentityEpoch: () => epoch, isCurrentIdentityEpoch: e => e === epoch,
    mcpHeaders: () => ({}), api: () => new Promise(resolve => { release = resolve; }) };
  const pending = need("createExplorer")(app).call("knowledge_base", { action: "get", knowledge_base_id: "a" });
  epoch = 2;
  release({ ok: true, data: { ok: true, result: { name: "old identity" } } });
  const result = await pending;
  assert.equal(result.stale, true);
  assert.equal(result.ok, false);
  assert.equal(result.result, undefined);
});

test("business errors remain errors even when the proxy HTTP request succeeds", async () => {
  const app = { captureIdentityEpoch: () => 1, isCurrentIdentityEpoch: () => true, mcpHeaders: () => ({}),
    api: async () => ({ ok: true, data: { ok: false, error: "Wiki is not configured", error_code: "WIKI_NOT_CONFIGURED" } }) };
  const result = await need("createExplorer")(app).call("read_document", { action: "list", source_type: "wiki" });
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/);
});

test("explicit capability flags win over a stale capability list", () => {
  const cap = need("capability");
  assert.equal(cap({ capability_flags: { wiki: false }, capabilities: ["wiki"] }, "wiki"), false);
  assert.equal(cap({ capabilities: ["wiki", "graph"] }, "graph"), true);
  assert.equal(cap({ capability_flags: { graph: true } }, "graph"), true);
  assert.equal(cap({}, "graph"), false);
});

test("knowledge base details unwrap the real nested status and preserve unknown counters", () => {
  const detail = need("normalizeDetail")({ knowledge_base: {
    status: { knowledge_base_id: "kb", status: { name: "Research", counts_known: false, documents: 0, chunks: 0,
      configured_capabilities: { wiki: true }, wiki: { available: "unavailable", pending_tasks: 2 } } },
    parser_engines: { engines: [{ name: "builtin", available: true }], docreader_connected: true },
    qa_profiles: [{ id: "profile", label: "Published" }],
  } });
  assert.equal(detail.status.name, "Research");
  assert.equal(detail.status.wiki.pending_tasks, 2);
  assert.equal(detail.documents, null);
  assert.equal(detail.engines.length, 1);
  assert.equal(detail.profiles[0].id, "profile");
});

test("partial search preserves per-source failures alongside valid document evidence", () => {
  const result = need("normalizeSearch")({ sources: ["document", "wiki"], partial: true,
    results: { document: { results: [{ chunk_id: "c1", knowledge_id: "d1", content: "Evidence" }] } },
    failed_sources: ["wiki"], failures: [{ source: "wiki", error: "not ready" }] });
  assert.equal(result.partial, true);
  assert.equal(result.groups[0].items[0].knowledge_id, "d1");
  assert.equal(result.groups[1].error, "not ready");
});

test("wiki XML search becomes readable hits without treating returned markup as HTML", () => {
  const result = need("normalizeSearch")({ sources: ["wiki"], results: { wiki: { content:
    '<search_results count="1"><page><knowledge_base_id>kb</knowledge_base_id><link>[[summary/test|Test &amp; title]]</link><summary>&lt;script&gt;bad&lt;/script&gt;</summary></page></search_results>' } } });
  assert.equal(result.groups[0].items.length, 1);
  assert.equal(result.groups[0].items[0].slug, "summary/test");
  assert.equal(result.groups[0].items[0].title, "Test & title");
  assert.match(result.groups[0].items[0].content, /script/);
});

test("source provenance labels never promote unverified evidence", () => {
  const label = need("provenanceLabel");
  assert.equal(label({ provenance: "verified" }), "已核对来源");
  assert.equal(label({ provenance: "unverified_source" }), "来源待核对");
  assert.equal(label({}), "来源未知");
});

test("canonical SourceRefV2 provenance_status is rendered without losing verification", () => {
  const label = need("provenanceLabel");
  assert.equal(label({ provenance_status: "verified" }), "已核对来源");
  assert.equal(label({ provenance_status: "unverified_source", provenance: "verified" }), "来源待核对");
});
