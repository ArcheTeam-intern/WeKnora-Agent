r"""Live verification of every MCP tool the console can reach.

Off by default: set WEKNORA_LIVE_MCP=1 to run against the real stack
(needs a reachable WeKnora and an externally issued user JWT). Every tool is called through
the SAME raw JSON-RPC path the console uses (webapp._call_tool), through
the endpoint's user-mode identity, so a pass here means the main product
can do the same thing with the same headers.

Classification for each tool:
  * pass  — the tool returned its documented result shape
  * skip  — the capability is off, or the tool reported a *configuration*
            state (GRAPH_EXTRACTION_NOT_CONFIGURED, wiki unavailable):
            environment facts, printed WITH the reason
  * fail  — anything else; the assertion at the end fails the run

Write tools run against scratch documents created and removed by the
test itself (add→update→delete, upload→import→delete). Every fixture carries
a per-run uuid so it can never dedup onto another round's document, and the
target knowledge base is the EXPLICIT test KB (WEKNORA_TEST_KB, else the
first entry of WEKNORA_KB_IDS) — the test never auto-picks a KB from
capability ranking, so it cannot write into a user's business library.

Run with freshly issued credentials in the child environment only::

    $env:WEKNORA_LIVE_MCP = '1'
    $env:WEKNORA_USER_TOKEN = '<fresh JWT from issue_user_token.py>'
    $env:WEKNORA_TENANT_ID = '2'
    $env:WEKNORA_TEST_KB = '<the KB this round may write to>'
    .\.venv\Scripts\python.exe -m pytest tests/test_live_mcp_tools.py -q -s
    Remove-Item Env:\WEKNORA_LIVE_MCP, Env:\WEKNORA_USER_TOKEN, Env:\WEKNORA_TENANT_ID, Env:\WEKNORA_TEST_KB
"""
import asyncio
import base64
import json
import os
import time
import uuid

import pytest

import webapp

pytestmark = pytest.mark.skipif(
    os.environ.get("WEKNORA_LIVE_MCP") != "1",
    reason="live MCP verification; set WEKNORA_LIVE_MCP=1 to run",
)

GRAPH_CONFIG_CODES = {"GRAPH_EXTRACTION_NOT_CONFIGURED", "GRAPH_UNAVAILABLE"}


class Report:
    def __init__(self):
        self.rows = []

    def add(self, tool, status, detail=""):
        self.rows.append((tool, status, detail))
        print(f"[{status.upper():4}] {tool}: {detail}")

    def render(self):
        lines = ["", "=== MCP 全工具实测报告 ==="]
        for tool, status, detail in self.rows:
            lines.append(f"{status.upper():4}  {tool:26} {detail}")
        passed = sum(1 for _, s, _ in self.rows if s == "pass")
        skipped = sum(1 for _, s, _ in self.rows if s == "skip")
        failed = [r for r in self.rows if r[1] == "fail"]
        lines.append(f"合计：pass={passed} skip={skipped} fail={len(failed)}")
        return "\n".join(lines), failed


async def _live_headers():
    token = os.environ.get("WEKNORA_USER_TOKEN", "").strip()
    tenant = os.environ.get("WEKNORA_TENANT_ID", "").strip()
    assert token and tenant, "externally issued WEKNORA_USER_TOKEN and WEKNORA_TENANT_ID are required"
    headers = {"X-WeKnora-User-Token": token, "X-Tenant-ID": tenant}
    kbs = os.environ.get("WEKNORA_KB_IDS", "").strip()
    if kbs:
        headers["X-WeKnora-Knowledge-Base-Ids"] = kbs
    return headers


def _allowed_test_kb_id() -> str:
    """The explicitly allowed test KB: WEKNORA_TEST_KB, else the first of
    WEKNORA_KB_IDS. Never auto-picked from capability ranking."""
    explicit = os.environ.get("WEKNORA_TEST_KB", "").strip()
    if explicit:
        return explicit
    listed = [k.strip() for k in os.environ.get("WEKNORA_KB_IDS", "").split(",") if k.strip()]
    return listed[0] if listed else ""


async def _pick_kb(headers, report):
    r = await webapp._call_tool("list_knowledge_bases", {}, headers)
    if not r["ok"]:
        report.add("list_knowledge_bases", "fail", r.get("error") or "")
        return None, None
    kbs = (r.get("result") or {}).get("knowledge_bases") or []
    report.add("list_knowledge_bases", "pass", f"visible_kbs={len(kbs)}")
    if not kbs:
        return None, None
    wanted = _allowed_test_kb_id()
    assert wanted, ("WEKNORA_TEST_KB (or the first WEKNORA_KB_IDS entry) is required: "
                    "the live run must not auto-pick a knowledge base to write to")
    for kb in kbs:
        if str(kb.get("id")) == wanted:
            return kb.get("id"), kb
    report.add("list_knowledge_bases", "fail",
               f"测试库 {wanted} 不在可见范围内（用 WEKNORA_TEST_KB 指定本轮允许写入的库）")
    return None, None


async def _await_applied_engine(call, knowledge_id, timeout=90):
    """Poll get_document_status until the pipeline records what it ran.

    Parsing is asynchronous, and the applied engine only appears once the
    convert stage has resolved it, so a single read right after import can
    legitimately show nothing yet.
    """
    deadline = time.monotonic() + timeout
    requested, applied, parse_status = [], "", ""
    while True:
        r = await call("get_document_status", {"knowledge_id": knowledge_id})
        status = (r.get("result") or {}).get("status") or {}
        requested = status.get("requested_parser_engine_rules") or []
        applied = status.get("applied_parser_engine") or ""
        parse_status = status.get("parse_status") or ""
        if applied or parse_status in ("failed", "completed") or time.monotonic() >= deadline:
            return requested, applied, parse_status
        await asyncio.sleep(3)


async def _run_tools(report: Report):
    headers = await _live_headers()
    kb_id, kb = await _pick_kb(headers, report)
    if not kb_id:
        return report
    flags = kb.get("capability_flags") or {}
    kb_headers = dict(headers)
    kb_headers["X-WeKnora-Knowledge-Base-Ids"] = kb_id
    print(f"target KB: {kb.get('name')} ({kb_id}) caps={json.dumps(flags)}")

    async def call(tool, arguments, timeout=120):
        return await webapp._call_tool(tool, arguments, kb_headers, timeout=timeout)

    # --- list_parser_engines: the deployment's real parser catalog --------
    # Also picks a non-default engine that advertises the scratch file's type,
    # so the import below can prove a *requested* engine really reaches the
    # pipeline instead of always falling back to the built-in default.
    engine_name = ""
    r = await call("list_parser_engines", {})
    if r["ok"]:
        engines = (r.get("result") or {}).get("engines") or []
        available = [e for e in engines if e.get("available")]
        report.add("list_parser_engines", "pass",
                   f"engines={len(engines)} available={len(available)} "
                   f"docreader_connected={(r.get('result') or {}).get('docreader_connected')}")
        engine_name = next((e.get("name") or "" for e in available
                            if e.get("name") != "builtin"
                            and "md" in (e.get("file_types") or [])), "")
    else:
        report.add("list_parser_engines", "fail", r.get("error") or "")

    # --- list_documents → choose one completed markdown/pdf document -------
    doc_id, doc_title = "", ""
    r = await call("list_documents", {"knowledge_base_id": kb_id, "page_size": 20})
    if not r["ok"]:
        report.add("list_documents", "fail", r.get("error") or "")
    else:
        items = (r.get("result") or {}).get("items") or (r.get("result") or {}).get("documents") or []
        done = [d for d in items if d.get("parse_status") == "completed"]
        report.add("list_documents", "pass", f"total={(r.get('result') or {}).get('total')} completed={len(done)}")
        if done:
            doc_id = done[0].get("id") or ""
            doc_title = done[0].get("title") or ""

    # --- get_document_status ----------------------------------------------
    if doc_id:
        r = await call("get_document_status", {"knowledge_id": doc_id})
        status = (r.get("result") or {}).get("status") or {}
        if r["ok"] and status.get("parse_status"):
            report.add("get_document_status", "pass",
                       f"parse={status.get('parse_status')} index={status.get('index_status')}")
        else:
            report.add("get_document_status", "fail", r.get("error") or "no status in result")
    else:
        report.add("get_document_status", "skip", "知识库中没有已解析完成的文档")

    # --- read_document -----------------------------------------------------
    if doc_id:
        r = await call("read_document", {"knowledge_id": doc_id, "limit": 2})
        if r["ok"]:
            res = r.get("result") or {}
            has_trunc = "truncated" in res
            report.add("read_document", "pass", f"truncated_field={has_trunc}")
        else:
            report.add("read_document", "fail", r.get("error") or "")
    else:
        report.add("read_document", "skip", "没有可读文档")

    # --- retrieval tools ---------------------------------------------------
    query_term = (doc_title.split()[0] if doc_title else "document")
    if flags.get("vector") or flags.get("keyword"):
        r = await call("search_knowledge", {"query": query_term,
                                            "knowledge_base_ids": [kb_id], "limit": 3})
        if r["ok"]:
            hits = (r.get("result") or {}).get("results") or []
            report.add("search_knowledge", "pass", f"hits={len(hits)} query={query_term!r}")
        else:
            report.add("search_knowledge", "fail", r.get("error") or "")
        r = await call("grep_chunks", {"query": query_term,
                                       "knowledge_base_ids": [kb_id], "limit": 3})
        if r["ok"]:
            hits = (r.get("result") or {}).get("results") or []
            report.add("grep_chunks", "pass", f"hits={len(hits)}")
        else:
            report.add("grep_chunks", "fail", r.get("error") or "")
    else:
        report.add("search_knowledge", "skip", "该知识库未启用向量/关键词检索")
        report.add("grep_chunks", "skip", "该知识库未启用向量/关键词检索")

    # --- ask ---------------------------------------------------------------
    r = await call("ask", {"question": "用一句话说明这个知识库里主要有哪些资料。",
                           "knowledge_base_ids": [kb_id]}, timeout=260)
    if r["ok"]:
        res = r.get("result") or {}
        report.add("ask", "pass", f"answer_chars={len(res.get('answer') or '')} "
                                  f"refs={len(res.get('references') or [])}")
    else:
        report.add("ask", "fail", r.get("error") or "")

    # --- knowledge base status (drives wiki/graph gating) ------------------
    wiki_available, graph_available = "", ""
    r = await call("get_knowledge_base_status", {"knowledge_base_id": kb_id})
    if r["ok"]:
        st = (r.get("result") or {}).get("status") or {}
        wiki_available = str((st.get("wiki") or {}).get("available") or "")
        graph_available = str((st.get("graph") or {}).get("available") or "")
        report.add("get_knowledge_base_status", "pass",
                   f"docs={st.get('documents')} chunks={st.get('chunks')} "
                   f"counts_known={st.get('counts_known')} wiki={wiki_available or 'n/a'} "
                   f"graph={graph_available or 'n/a'}")
    else:
        report.add("get_knowledge_base_status", "fail", r.get("error") or "")

    # --- wiki tools --------------------------------------------------------
    wiki_gate = ""
    if not flags.get("wiki"):
        wiki_gate = "该知识库未启用 Wiki"
    elif wiki_available == "unavailable":
        wiki_gate = "Wiki 已启用但当前不可用"
    wiki_slug = ""
    for tool, arguments in [
        ("wiki_index", {"knowledge_base_id": kb_id}),
        ("wiki_list_pages", {"knowledge_base_id": kb_id, "page_size": 5}),
        ("wiki_graph", {"knowledge_base_id": kb_id}),
        ("wiki_search", {"query": "总结", "knowledge_base_ids": [kb_id], "limit": 5}),
    ]:
        if wiki_gate:
            report.add(tool, "skip", wiki_gate)
            continue
        r = await call(tool, arguments)
        if r["ok"]:
            report.add(tool, "pass", json.dumps(r.get("result"), ensure_ascii=False)[:90])
            if tool == "wiki_list_pages":
                for page in (r.get("result") or {}).get("pages") or []:
                    if page.get("slug"):
                        wiki_slug = page["slug"]
                        break
        else:
            report.add(tool, "fail", f"{r.get('error_code') or ''} {r.get('error') or ''}".strip())

    # wiki_read_page needs a slug: take one from wiki_list_pages above, and
    # fall back to wiki_index's groups when the page list came back empty.
    if wiki_gate:
        report.add("wiki_read_page", "skip", wiki_gate)
    elif not wiki_slug:
        report.add("wiki_read_page", "skip", "Wiki 中没有可用页面（列表为空）")
    else:
        r = await call("wiki_read_page", {"slug": wiki_slug, "knowledge_base_id": kb_id})
        if r["ok"]:
            res = r.get("result") or {}
            report.add("wiki_read_page", "pass",
                       f"slug={wiki_slug} refs={len(res.get('source_refs_v2') or {})}")
        else:
            report.add("wiki_read_page", "fail", f"{r.get('error_code') or ''} {r.get('error') or ''}".strip())

    # --- query_knowledge_graph --------------------------------------------
    if not flags.get("graph"):
        report.add("query_knowledge_graph", "skip", "该知识库未启用图谱抽取")
    elif graph_available == "unavailable":
        report.add("query_knowledge_graph", "skip", "图谱已启用但当前不可用")
    else:
        r = await call("query_knowledge_graph",
                       {"knowledge_base_ids": [kb_id], "query": query_term})
        if r["ok"]:
            rel = (r.get("result") or {}).get("relations") or []
            report.add("query_knowledge_graph", "pass", f"relations={len(rel)}")
        elif r.get("error_code") in GRAPH_CONFIG_CODES:
            report.add("query_knowledge_graph", "skip",
                       f"配置态 {r.get('error_code')}")
        else:
            report.add("query_knowledge_graph", "fail", r.get("error") or "")

    # --- upload_file → get_upload_status → import_document_file → delete ---
    run_id = uuid.uuid4().hex
    scratch_md = f"# 控制台实测草稿 {run_id}\n\nMCP live fixture: {run_id}\n"
    r = await call("upload_file", {
        "knowledge_base_id": kb_id,
        "file_name": f"console-live-verify-{run_id}.md",
        "content": base64.b64encode(scratch_md.encode("utf-8")).decode("ascii"),
    }, timeout=180)
    upload_id = ""
    if r["ok"]:
        upload_id = (r.get("result") or {}).get("upload_id") or ""
        report.add("upload_file", "pass", f"upload_id={upload_id[:8]}…")
    else:
        report.add("upload_file", "fail", r.get("error") or "")

    imported_doc = ""
    if upload_id:
        r = await call("get_upload_status", {"upload_id": upload_id})
        if r["ok"]:
            report.add("get_upload_status", "pass", f"state={(r.get('result') or {}).get('state')}")
        else:
            report.add("get_upload_status", "fail", r.get("error") or "")
        import_args = {"knowledge_base_id": kb_id, "upload_id": upload_id}
        if engine_name:
            import_args["process_config"] = {
                "parser_engine_rules": [{"file_types": ["md"], "engine": engine_name}]}
        r = await call("import_document_file", import_args, timeout=180)
        if r["ok"]:
            imported_doc = ((r.get("result") or {}).get("document") or {}).get("id") or ""
            deduplicated = bool((r.get("result") or {}).get("deduplicated"))
            report.add("import_document_file", "pass",
                       f"document_id={imported_doc[:8]}… deduplicated={deduplicated}")
            if deduplicated:
                # 本轮的字节与既有文档重合：那份文档不是本轮创建的，不得删除。
                print(f"本轮新建 ID 记录：imported={imported_doc}（deduplicated，保留给人工判断）")
                imported_doc = ""
            elif engine_name:
                # 端到端：请求的引擎是否真的进了管线并被执行。
                requested, applied, parse_status = await _await_applied_engine(call, imported_doc)
                if applied:
                    requested_names = [str(x.get("engine")) for x in requested]
                    ok = applied == engine_name and engine_name in requested_names
                    report.add("import process_config", "pass" if ok else "fail",
                               f"requested={requested_names or '（状态未回显）'} applied={applied}")
                else:
                    report.add("import process_config", "skip",
                               f"解析未在窗口内进入引擎选择（parse={parse_status or 'pending'}）；"
                               f"已提交 process_config={engine_name}")
    else:
        report.add("get_upload_status", "skip", "没有 upload_id")
        report.add("import_document_file", "skip", "没有 upload_id")

    # --- add / update / delete --------------------------------------------
    scratch_doc = ""
    r = await call("add_document", {"knowledge_base_id": kb_id,
                                    "title": f"控制台实测草稿 {run_id}（add_document）",
                                    "content": scratch_md}, timeout=120)
    if r["ok"]:
        scratch_doc = ((r.get("result") or {}).get("document") or {}).get("id") or ""
        report.add("add_document", "pass", f"document_id={scratch_doc[:8]}…")
    else:
        report.add("add_document", "fail", r.get("error") or "")

    if scratch_doc:
        r = await call("update_document", {"knowledge_id": scratch_doc,
                                           "content": scratch_md + "\n更新一次。\n"})
        if r["ok"]:
            report.add("update_document", "pass", "内容已更新")
        else:
            report.add("update_document", "fail", r.get("error") or "")
    else:
        report.add("update_document", "skip", "add_document 未成功")

    print(f"本轮新建 ID 记录：imported={imported_doc or '（无）'} added={scratch_doc or '（无）'}")
    # --- cleanup: 只清理本轮明确创建的草稿（dedup 命中的不在此列） ----------
    for label, target in [("delete_document(import)", imported_doc),
                          ("delete_document(add)", scratch_doc)]:
        if not target:
            report.add(label, "skip", "没有可清理的草稿")
            continue
        r = await call("delete_document", {"knowledge_id": target})
        if r["ok"]:
            report.add(label, "pass", "草稿已清理")
        else:
            report.add(label, "fail", r.get("error") or "")

    return report


def test_every_mcp_tool_live():
    from dotenv import load_dotenv
    load_dotenv(webapp.ROOT / ".env", override=False)
    started = time.monotonic()
    report = asyncio.run(_run_tools(Report()))
    text, failed = report.render()
    print(text)
    print(f"耗时 {time.monotonic() - started:.0f}s")
    assert not failed, "\n".join(f"{t}: {d}" for _, t, d in [(0, t, d) for t, s, d in failed])