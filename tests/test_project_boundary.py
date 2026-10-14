"""Keep this prototype limited to the CLI and standard MCP agent library."""
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_root_production_python_is_only_cli_and_agent():
    assert {path.name for path in ROOT.glob("*.py")} == {"main.py", "agent.py"}


def test_project_has_no_web_application_directory():
    assert not (ROOT / "web").exists()


def test_runtime_requirements_have_no_direct_web_application_packages():
    # MCP may depend on these transitively for SDK HTTP transport fixtures.
    # The Agent itself must not declare or host a separate web application.
    direct_packages = {
        re.split(r"[\[<>=!~;\s]", line.strip(), maxsplit=1)[0].lower().replace("_", "-")
        for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    assert not direct_packages & {"starlette", "sse-starlette", "uvicorn", "fastapi"}
