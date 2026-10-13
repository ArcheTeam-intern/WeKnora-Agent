"""Real MCP transport fixture; these records are test data, not WeKnora results."""
from mcp.server.fastmcp import FastMCP

server = FastMCP("test-weknora")


@server.tool()
def search_knowledge(query: str) -> dict:
    return {"document_id": "doc-1", "chunk_id": "chunk-1", "text": "项目负责人是张三。"}


@server.tool()
def wiki_read_page(slug: str) -> dict:
    return {"slug": slug, "content": "张三负责项目。", "source_refs_v2": [{"document_id": "doc-1"}]}


@server.tool()
def query_knowledge_graph(query: str) -> dict:
    return {"relations": [{"id": "rel-1", "source": "张三", "target": "项目",
                           "source_refs_v2": [{"document_id": "doc-1", "chunk_id": "chunk-1"}]}]}


@server.tool()
def read_document(document_id: str) -> str:
    raise ValueError("permission denied")


@server.tool()
def import_document_file() -> str:
    raise AssertionError("write tool must never be called")


if __name__ == "__main__":
    server.run(transport="stdio")
