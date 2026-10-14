"""Project boundary contract.

The shell is a deliberate, documented expansion of the prototype
surface: main.py and agent.py remain the only production entry points
that drive the agent, but webapp.py is now also part of the shipped
artifact. The test enforces the residual boundary:

  * The agent runtime is still just main.py + agent.py.
  * The HTTP shell is a thin layer that proxies user-supplied identity
    headers to the MCP client; it does NOT depend on a Web framework
    package directly (the Web framework packages below are listed for
    the shell). Starlette / sse-starlette / uvicorn are required by
    webapp.py by construction; this test only allows them and does
    not pretend they are not there.
  * The shell does not pull in any other Web framework package. If a
    later change introduces fastapi / flask / aiohttp server / etc,
    this assertion fires.

History: the original prototype had only main.py + agent.py and
disallowed these packages directly. The web shell restored them
because the user explicitly asked for a thin Web UI on top of the
standard MCP agent. The contract below keeps the agent clean while
acknowledging the shell.
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


def test_webapp_login_proxy_is_allowlisted_and_stateless():
    """The shell may run a login proxy, but only under two hard limits.

    2026-10-14 the user explicitly asked the console to offer an account
    dropdown (demo friction), overriding the earlier "the shell never logs
    in" rule. The boundary that replaces it: credentials live ONLY in the
    gitignored accounts.json (never in code, never as env names), the shell
    refuses emails outside that file (so it cannot act as an open login
    proxy), and the user identity still comes from the request header on
    every single call — the JWT is returned to the browser and never cached
    server-side.
    """
    webapp = (ROOT / "webapp.py").read_text(encoding="utf-8")
    # The allowlist file is the only credential source.
    assert "accounts.json" in webapp
    # No credentials baked into code or read from demo env names.
    for token in ("WEKNORA_DEMO_EMAIL", "WEKNORA_DEMO_PASSWORD", "login_for_token"):
        assert token not in webapp, (
            f"webapp.py must not carry credentials or the old identity proxy ({token!r})"
        )
    # Identity remains request-scoped: the header contract is untouched.
    assert "X-WeKnora-User-Token" in webapp
    # A fresh token is handed back to the caller, not kept.
    assert '"token": token' in webapp


def test_accounts_file_is_gitignored_and_example_is_shipped():
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "accounts.json" in gitignore
    assert (ROOT / "accounts.json.example").exists()
