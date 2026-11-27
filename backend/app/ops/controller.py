"""Controlled operations on a single demo-app workspace.

Only fixed, allowlisted commands run, with a scrubbed environment, resource limits
and timeouts (cwd=workspace; tests come from a trusted backend-owned copy). No caller-supplied paths or argv.
"""
import json
import os
import resource
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

MAX_OUTPUT = 4000
TEST_TIMEOUT = 30
START_WAIT = 5.0
# Trusted test suite: the pristine template's tests, outside every agent-writable workspace.
# Verification never runs the workspace's own tests/ (the running app could rewrite them).
TRUSTED_TESTS = Path(__file__).resolve().parents[3] / "sandbox" / "demo_app" / "tests"
# Runs under `python -I -S`: no cwd/script dir/site-packages on sys.path, no PYTHON* env vars.
# unittest is imported before the workspace is reachable, and the workspace is appended LAST,
# so workspace files cannot shadow the runner or stdlib modules; they can only provide the
# app modules under test (app, inventory).
TEST_RUNNER = """# rescueops-test-runner
import sys, unittest
workspace, tests = sys.argv[1], sys.argv[2]
sys.path.append(workspace)
suite = unittest.defaultTestLoader.discover(tests, top_level_dir=tests)
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() and result.testsRun else 1 if result.testsRun else 5)
"""


def _truncate(text: str, limit: int = MAX_OUTPUT) -> str:
    return text if len(text) <= limit else "...[truncated]...\n" + text[-limit:]


def _limits() -> None:  # runs in child before exec
    resource.setrlimit(resource.RLIMIT_AS, (512 * 2**20, 512 * 2**20))
    resource.setrlimit(resource.RLIMIT_FSIZE, (10 * 2**20, 10 * 2**20))
    # No setsid(): children stay in the ops server's process group, so the MCP client's
    # group kill on shutdown also reaches the app/tests even if this server is SIGKILLed.


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class OpsController:
    def __init__(self, workspace: Path, tests_dir: Path = TRUSTED_TESTS):
        self.root = Path(workspace).resolve(strict=True)
        self.tests_dir = Path(tests_dir).resolve(strict=True)
        if self.tests_dir.is_relative_to(self.root):
            raise ValueError("trusted tests must live outside the workspace")
        if not (self.root / "app.py").is_file():
            raise ValueError("workspace has no app.py")
        self.log_path = self.root / "logs" / "app.log"
        self.proc: subprocess.Popen | None = None
        self.port: int | None = None
        self.started_at: float | None = None

    # -- helpers ---------------------------------------------------------
    def _env(self, extra: dict | None = None) -> dict:
        env = {"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
               "HOME": str(self.root), "LANG": "C.UTF-8"}
        env.update(extra or {})
        return env  # never inherits secrets such as GEMINI_API_KEY

    def _safe_log_path(self) -> Path:
        p = self.log_path.resolve()
        if not p.is_relative_to(self.root):
            raise PermissionError("log path escapes workspace")
        return p

    def _running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    # -- tools -----------------------------------------------------------
    def get_app_status(self) -> dict:
        if self.proc is None:
            return {"state": "not_started"}
        if self._running():
            return {"state": "running", "pid": self.proc.pid, "port": self.port,
                    "uptime_s": round(time.time() - (self.started_at or time.time()), 1)}
        return {"state": "exited", "exit_code": self.proc.returncode}

    def start_app(self) -> dict:
        if self._running():
            return {"ok": True, "message": "already running", **self.get_app_status()}
        self.log_path.parent.mkdir(exist_ok=True)
        log = open(self._safe_log_path(), "a", encoding="utf-8")
        log.write(f"--- start {time.strftime('%H:%M:%S')} ---\n")
        log.flush()
        self.port = _free_port()
        self.proc = subprocess.Popen(
            [sys.executable, "-E", "-s", "app.py"], cwd=self.root, env=self._env({"PORT": str(self.port)}),
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, preexec_fn=_limits)
        log.close()
        self.started_at = time.time()
        deadline = time.time() + START_WAIT
        while time.time() < deadline:
            if not self._running():
                return {"ok": False, "message": "app exited during startup",
                        **self.get_app_status(), "log_tail": self.read_logs(20)["log"]}
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    return {"ok": True, "message": "app started", **self.get_app_status()}
            except OSError:
                time.sleep(0.1)
        return {"ok": False, "message": "app did not open its port in time", **self.get_app_status()}

    def stop_app(self) -> dict:
        if not self._running():
            return {"ok": True, "message": "not running", **self.get_app_status()}
        self.proc.terminate()
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=3)
        return {"ok": True, "message": "stopped", **self.get_app_status()}

    def restart_app(self) -> dict:
        self.stop_app()
        return self.start_app()

    def read_logs(self, lines: int = 50) -> dict:
        lines = max(1, min(int(lines), 200))
        p = self._safe_log_path()
        if not p.exists():
            return {"log": "", "message": "no logs yet (app never started)"}
        text = "\n".join(p.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
        return {"log": _truncate(text)}

    def run_health_check(self) -> dict:
        if not self._running():
            return {"healthy": False, "reason": "app is not running", **self.get_app_status()}
        results, healthy = {}, True
        for path in ("/health", "/api/items"):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=3) as r:
                    results[path] = {"status": r.status, "body": _truncate(r.read().decode(), 500)}
            except urllib.error.HTTPError as e:
                results[path] = {"status": e.code, "body": _truncate(e.read().decode(errors="replace"), 500)}
            except OSError as e:
                results[path] = {"status": None, "error": str(e)}
            healthy = healthy and results[path].get("status") == 200
        return {"healthy": healthy, "checks": results}

    def run_tests(self) -> dict:
        # Fresh backend-owned copy of the trusted tests per run: the tests resolve their imports
        # relative to their own location, so this dir holds nothing but tests/.
        with tempfile.TemporaryDirectory(prefix="rescueops-tests-") as tmp:
            tests = Path(tmp) / "tests"
            shutil.copytree(self.tests_dir, tests, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            try:
                r = subprocess.run(
                    [sys.executable, "-I", "-S", "-c", TEST_RUNNER, str(self.root), str(tests)],
                    # cwd=workspace is not importable under -I; it keeps the runner findable by
                    # mcp_bridge.kill_workspace_processes if the ops server dies mid-test.
                    cwd=self.root, env=self._env(), stdin=subprocess.DEVNULL, capture_output=True,
                    text=True, timeout=TEST_TIMEOUT, preexec_fn=_limits)
            except subprocess.TimeoutExpired:
                return {"passed": False, "exit_code": None, "output": f"tests timed out after {TEST_TIMEOUT}s"}
        return {"passed": r.returncode == 0, "exit_code": r.returncode,
                "output": _truncate(r.stdout + r.stderr)}

    def close(self) -> None:
        self.stop_app()


def as_text(result: dict) -> str:
    return json.dumps(result, indent=2)
