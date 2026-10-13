"""Real FastMCP server over streamable HTTP, used by test_http_mcp.py only.

This fixture mirrors WeKnora's read-only tool surface (parameter names
included) so the Agent can complete a real HTTP tools/list and tools/call
handshake without standing up the WeKnora service. It is test data, not
production results, and must never be imported by main.py or agent.py.
"""
import socket

from mcp.server.fastmcp import FastMCP


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def build_server(host: str = "127.0.0.1", port: int | None = None) -> FastMCP:
    server = FastMCP("test-weknora-http", host=host, port=port or free_port(),
                     json_response=True, warn_on_duplicate_tools=False)

    @server.tool()
    def list_knowledge_bases() -> dict:
        return {"knowledge_bases": [], "total": 0}

    @server.tool()
    def list_documents(knowledge_base_id: str) -> dict:
        return {"documents": [], "total": 0, "knowledge_base_id": knowledge_base_id}

    @server.tool()
    def search_knowledge(query: str, mode: str = "hybrid", limit: int = 10,
                         knowledge_base_ids: list[str] | None = None) -> dict:
        return {"results": [], "query": query, "mode": mode, "limit": limit}

    @server.tool()
    def grep_chunks(query: str, limit: int = 10,
                    knowledge_base_ids: list[str] | None = None) -> dict:
        return {"chunks": [], "query": query}

    @server.tool()
    def read_document(knowledge_id: str, offset: int = 0, limit: int = 20,
                      query: str | None = None) -> dict:
        # 真实契约使用 knowledge_id；fixture 直接返回截断元数据。
        return {"knowledge_id": knowledge_id, "chunks": [],
                "offset": offset, "limit": limit, "truncated": False,
                "next_offset": None, "total_chunks": 0}

    @server.tool()
    def wiki_index(knowledge_base_id: str, limit: int = 50) -> dict:
        return {"entries": [], "knowledge_base_id": knowledge_base_id}

    @server.tool()
    def wiki_search(query: str, regex: bool = False,
                    knowledge_base_ids: list[str] | None = None, limit: int = 10) -> dict:
        return {"pages": [], "query": query}

    @server.tool()
    def wiki_read_page(slug: str, knowledge_base_id: str | None = None) -> dict:
        return {"slug": slug, "content": "", "source_refs_v2": []}

    @server.tool()
    def wiki_list_pages(knowledge_base_id: str, page: int = 1, page_size: int = 20,
                        page_type: str | None = None, status: str | None = None,
                        query: str | None = None) -> dict:
        return {"pages": [], "total": 0, "page": page, "page_size": page_size}

    @server.tool()
    def wiki_graph(knowledge_base_id: str, center: str | None = None,
                   depth: int = 1, limit: int = 100, page_type: str | None = None) -> dict:
        return {"graph_type": "wiki_links", "nodes": [], "edges": []}

    @server.tool()
    def query_knowledge_graph(knowledge_base_ids: list[str], query: str,
                              limit: int = 30) -> dict:
        return {"relations": [], "knowledge_base_ids": knowledge_base_ids, "query": query}

    @server.tool()
    def get_document_status(knowledge_id: str) -> dict:
        return {"knowledge_id": knowledge_id, "parse_status": "completed"}

    @server.tool()
    def get_knowledge_base_status(knowledge_base_id: str) -> dict:
        return {"knowledge_base_id": knowledge_base_id, "document_count": 0,
                "wiki_enabled": False, "graph_enabled": False}

    return server


if __name__ == "__main__":
    build_server().run(transport="streamable-http")
