import json
import os
import shutil
import sys
from pathlib import Path

import anyio
import pytest
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from app.ops.controller import OpsController
from app.workspace import create_workspace

BACKEND = Path(__file__).resolve().parent.parent


@pytest.fixture
def make_ops(tmp_path):
    made = []

    def _make(scenario):
        ws = create_workspace(scenario, f"r{len(made)}", runs_dir=tmp_path)
        ops = OpsController(ws)
        made.append(ops)
        return ws, ops

    yield _make
    for ops in made:
        ops.close()


def _healthy_ws(tmp_path):
    ws = tmp_path / "healthy" / "app"
    shutil.copytree(BACKEND.parent / "sandbox" / "demo_app", ws)
    return ws


def test_healthy_template_passes_all_checks(tmp_path):
    ops = OpsController(_healthy_ws(tmp_path))
    try:
        assert ops.get_app_status() == {"state": "not_started"}
        assert ops.run_health_check()["healthy"] is False
        assert ops.start_app()["ok"] is True
        hc = ops.run_health_check()
        assert hc["healthy"] is True, hc
        assert ops.run_tests()["passed"] is True
        assert "listening" in ops.read_logs()["log"]
        assert ops.stop_app()["ok"] and ops.get_app_status()["state"] == "exited"
    finally:
        ops.close()


def test_bad_config_crashes_on_start(make_ops):
    _, ops = make_ops("bad-config")
    r = ops.start_app()
    assert r["ok"] is False and "max_items" in r["log_tail"]
    assert ops.run_tests()["passed"] is False


def test_missing_file_crashes_on_start(make_ops):
    _, ops = make_ops("missing-file")
    r = ops.start_app()
    assert r["ok"] is False and "FileNotFoundError" in r["log_tail"]


def test_code_bug_detected_then_repaired(make_ops):
    ws, ops = make_ops("code-bug")
    assert ops.start_app()["ok"] is False  # fail-fast on bad code
    assert "KeyError" in ops.read_logs()["log"]
    assert ops.run_tests()["passed"] is False
    src = (ws / "inventory.py").read_text().replace('item["quantity"]', 'item["qty"]')
    (ws / "inventory.py").write_text(src)
    assert ops.restart_app()["ok"] is True
    assert ops.run_health_check()["healthy"] is True
    assert ops.run_tests()["passed"] is True


def test_child_env_is_scrubbed(make_ops, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "secret-should-not-leak")
    ws, ops = make_ops("code-bug")
    (ws / "tests" / "test_env.py").write_text(
        "import os, unittest\n"
        "class T(unittest.TestCase):\n"
        "    def test_env(self):\n"
        "        self.assertNotIn('GEMINI_API_KEY', os.environ)\n")
    out = ops.run_tests()["output"]
    assert "test_env" in out and "secret-should-not-leak" not in out
    assert "test_env (test_env.T" in out and "ok" in out


def test_log_symlink_escape_blocked(make_ops, tmp_path):
    ws, ops = make_ops("code-bug")
    outside = tmp_path / "outside.txt"
    outside.write_text("top secret")
    (ws / "logs").mkdir()
    os.symlink(outside, ws / "logs" / "app.log")
    with pytest.raises(PermissionError):
        ops.read_logs()


def test_read_logs_clamps_lines(make_ops):
    _, ops = make_ops("bad-config")
    ops.start_app()
    assert ops.read_logs(10_000)["log"].count("\n") < 200


def test_rejects_non_workspace(tmp_path):
    with pytest.raises(ValueError):
        OpsController(tmp_path)


def test_mcp_server_over_stdio(tmp_path):
    ws = create_workspace("code-bug", "mcp", runs_dir=tmp_path)

    async def main():
        params = StdioServerParameters(command=sys.executable, args=["-m", "app.ops.server", str(ws)],
                                       cwd=str(BACKEND))
        async with stdio_client(params) as (r, w), ClientSession(r, w) as s:
            await s.initialize()
            names = {t.name for t in (await s.list_tools()).tools}
            assert names == {"get_app_status", "start_app", "stop_app", "restart_app",
                             "read_logs", "run_health_check", "run_tests"}
            res = await s.call_tool("run_tests", {})
            payload = res.structured_content or json.loads(res.content[0].text)
            payload = payload.get("result", payload)
            assert payload["passed"] is False and "KeyError" in payload["output"]

    anyio.run(main)
