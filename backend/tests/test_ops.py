import json
import os
import shutil
import signal
import subprocess
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


# ------------------------------------------------------------------ process-group regressions
def _procs(ws):
    """{role: (pid, pgid)} for processes belonging to this workspace's MCP stack."""
    out = subprocess.run(["ps", "-ww", "-eo", "pid=,pgid=,args="], capture_output=True, text=True).stdout
    found = {}
    for line in out.splitlines():
        pid, pgid, args = line.split(None, 2)
        if "app.ops.server" in args and str(ws) in args:
            found["server"] = (int(pid), int(pgid))
        elif args.endswith("-E -s app.py"):
            found.setdefault("app", []).append((int(pid), int(pgid)))
        elif "unittest discover" in args and "ps -eo" not in args:
            found.setdefault("tests", []).append((int(pid), int(pgid)))
    return found


def _ours(entries, server_pgid):
    return [e for e in entries or [] if e[1] == server_pgid]


def _fixed_slow_ws(tmp_path, name):
    ws = create_workspace("code-bug", name, runs_dir=tmp_path)
    (ws / "inventory.py").write_text((ws / "inventory.py").read_text().replace('item["quantity"]', 'item["qty"]'))
    (ws / "tests" / "test_slow.py").write_text(
        "import time, unittest\nclass S(unittest.TestCase):\n    def test_slow(self):\n        time.sleep(20)\n")
    return ws


def test_children_share_server_group_and_stop_app_spares_server(tmp_path):
    ws = _fixed_slow_ws(tmp_path, "pg")
    from app.mcp_bridge import MCPManager

    async def main():
        async with MCPManager(ws) as m:
            assert (await m.call("start_app"))["result"]["ok"]
            p = _procs(ws)
            server_pid, server_pgid = p["server"]
            assert server_pid == server_pgid            # server leads its own group (SDK start_new_session)
            app = _ours(p.get("app"), server_pgid)
            assert len(app) == 1 and app[0][0] != server_pgid  # app is a member, not a group leader
            assert (await m.call("stop_app"))["result"]["message"] == "stopped"
            assert not _ours(_procs(ws).get("app"), server_pgid)
            # the server survived stop_app and still serves requests
            assert _procs(ws)["server"][0] == server_pid
            assert (await m.call("get_app_status"))["result"]["state"] == "exited"
            assert (await m.call("stop_app"))["result"]["message"] == "not running"  # idempotent

    anyio.run(main)


def test_group_kill_reaches_children_even_if_server_was_sigkilled(tmp_path):
    """Worst case: the ops server dies without running atexit; MCP client teardown must still
    kill the app and a running test subprocess (they share the server's process group)."""
    ws = _fixed_slow_ws(tmp_path, "sigkill")
    from app.mcp_bridge import MCPManager
    state = {}

    async def main():
        async with MCPManager(ws) as m:
            assert (await m.call("start_app"))["result"]["ok"]
            tests = anyio.create_task_group()
            async with tests:
                tests.start_soon(m.call, "run_tests")
                for _ in range(50):
                    await anyio.sleep(0.1)
                    p = _procs(ws)
                    if _ours(p.get("tests"), p["server"][1]):
                        break
                server_pid, pgid = p["server"]
                state["pgid"] = pgid
                assert _ours(p.get("app"), pgid) and _ours(p.get("tests"), pgid)
                os.kill(server_pid, signal.SIGKILL)       # no atexit, no graceful stop
                await anyio.sleep(0.3)
                assert _ours(_procs(ws).get("app"), pgid)  # children orphaned until group kill...
                tests.cancel_scope.cancel()
        # ...MCPManager exit → SDK killpg(server group) must clean them up

    anyio.run(main)
    for _ in range(30):
        p = _procs(ws)
        if not _ours(p.get("app"), state["pgid"]) and not _ours(p.get("tests"), state["pgid"]):
            break
        import time
        time.sleep(0.1)
    p = _procs(ws)
    assert not _ours(p.get("app"), state["pgid"]) and not _ours(p.get("tests"), state["pgid"])


def test_stop_app_safe_when_process_already_exited(tmp_path):
    ops = OpsController(_healthy_ws(tmp_path))
    try:
        assert ops.start_app()["ok"]
        os.kill(ops.proc.pid, signal.SIGKILL)           # dies behind the controller's back
        ops.proc.wait(timeout=5)
        assert ops.stop_app()["message"] == "not running"
        # race: process already gone/reaped but _running() still said True
        assert ops.start_app()["ok"]
        pid = ops.proc.pid
        os.kill(pid, signal.SIGKILL)
        ops.proc.wait(timeout=5)
        ops._running = lambda: True                     # simulate exit between poll() and terminate()
        r = ops.stop_app()                              # must not raise ProcessLookupError
        assert r["ok"] and r["message"] == "stopped" and ops.proc.returncode == -signal.SIGKILL
    finally:
        del ops._running
        ops.close()


def test_stop_app_never_signals_own_process_group(tmp_path, monkeypatch):
    """stop_app must target only the app PID: the app shares the server's group."""
    calls = []
    monkeypatch.setattr(os, "killpg", lambda *a: calls.append(a))
    ops = OpsController(_healthy_ws(tmp_path))
    try:
        assert ops.start_app()["ok"]
        assert os.getpgid(ops.proc.pid) == os.getpgid(0)  # same group as the "server" (this process)
        assert ops.stop_app()["message"] == "stopped"
        assert calls == []
    finally:
        ops.close()
