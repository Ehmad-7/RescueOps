"""Ops MCP server (stdio) bound to exactly one workspace.

Usage: python -m app.ops.server <workspace_dir>
"""
import atexit
import signal
import sys
from pathlib import Path

from mcp.server.mcpserver import MCPServer

from app.ops.controller import OpsController


def build_server(workspace: Path) -> tuple[MCPServer, OpsController]:
    ops = OpsController(workspace)
    mcp = MCPServer(name="rescueops-ops", instructions=(
        "Controlled operations for the demo inventory service in this run's workspace. "
        "No shell access; only these tools are available."))

    @mcp.tool(description="Get whether the app process is running, its port, uptime or exit code.")
    def get_app_status() -> dict:
        return ops.get_app_status()

    @mcp.tool(description="Start the app. Returns startup result and log tail if it crashes.")
    def start_app() -> dict:
        return ops.start_app()

    @mcp.tool(description="Stop the running app process.")
    def stop_app() -> dict:
        return ops.stop_app()

    @mcp.tool(description="Restart the app (stop then start). Use after fixing files.")
    def restart_app() -> dict:
        return ops.restart_app()

    @mcp.tool(description="Read the last N lines (1-200) of the app log (stdout/stderr).")
    def read_logs(lines: int = 50) -> dict:
        return ops.read_logs(lines)

    @mcp.tool(description="HTTP health check of /health and /api/items on the running app.")
    def run_health_check() -> dict:
        return ops.run_health_check()

    @mcp.tool(description="Run the app's unit test suite and return pass/fail and output.")
    def run_tests() -> dict:
        return ops.run_tests()

    return mcp, ops


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: python -m app.ops.server <workspace_dir>")
    mcp, ops = build_server(Path(sys.argv[1]))
    atexit.register(ops.close)
    # The MCP client terminates this process with SIGTERM; exit normally so atexit
    # stops the app process group instead of orphaning it.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    mcp.run("stdio")


if __name__ == "__main__":
    main()
