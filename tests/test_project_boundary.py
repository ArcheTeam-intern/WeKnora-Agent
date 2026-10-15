"""Only main.py, agent.py and the thin webapp.py compose the Agent runtime.
User credential issuance belongs to an external WeKnora utility; every Agent
knowledge operation crosses the MCP boundary with caller-supplied identity.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_root_production_python_is_only_cli_and_agent():
    # The agent runtime is main.py + agent.py. The web shell
    # (webapp.py) is documented as a separate, optional thin
    # layer and lives alongside them.
    assert {path.name for path in ROOT.glob("*.py")} == {"main.py", "agent.py", "webapp.py"}


def test_root_has_web_shell_file_for_the_documented_optional_ui():
    # webapp.py is the documented thin shell. It must exist; it must
    # not pull in any framework package the agent itself does not
    # already use transitively.
    assert (ROOT / "webapp.py").exists()


def test_root_has_no_other_web_application_directory():
    # No SPA build, no public/, no templates/ tree. The shell only
    # serves one static HTML file at web/index.html.
    assert (ROOT / "web").exists()
    assert (ROOT / "web" / "index.html").exists()
    for forbidden in ("public", "static", "templates", "dist", "build"):
        assert not (ROOT / forbidden).exists(), (
            f"unexpected web asset directory: {forbidden}")


def test_runtime_requirements_have_no_unauthorised_web_application_packages():
    # The shell pulls starlette / sse-starlette / uvicorn as direct
    # dependencies. No other Web framework package (fastapi, flask,
    # django, aiohttp-server, ...) may be added.
    direct_packages = {
        re.split(r"[\[<>=!~;\s]", line.strip(), maxsplit=1)[0].lower().replace("_", "-")
        for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    web_framework_forbidden = {
        "fastapi", "flask", "django", "starlette-fastapi", "aiohttp",
        "tornado", "sanic", "bottle", "falcon", "pyramid", "cherrypy",
    }
    found = direct_packages & web_framework_forbidden
    assert not found, f"unauthorised web framework packages: {sorted(found)}"


def test_production_runtime_has_only_mcp_access_and_external_identity():
    for name in ("main.py", "agent.py", "webapp.py"):
        source = (ROOT / name).read_text(encoding="utf-8")
        for forbidden in ("accounts.json", "/api/v1/", "_login_upstream", "sqlite3", "import redis", "import neo4j"):
            assert forbidden not in source, f"{name} violates runtime boundary: {forbidden}"
    assert "X-WeKnora-User-Token" in (ROOT / "webapp.py").read_text(encoding="utf-8")
