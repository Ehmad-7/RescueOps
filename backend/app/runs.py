"""In-memory run lifecycle: create workspace → connect MCP → run agent → clean up.

Status: queued → running → verified | unverified | failed | cancelled
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from app import events as ev
from app.agent import GeminiModel, Model, RecoveryAgent
from app.config import Settings
from app.events import EventLog
from app.mcp_bridge import MCPManager
from app.workspace import create_workspace, delete_workspace, new_run_id

ACTIVE = {"queued", "running"}
MAX_STORED_RUNS = 100


class RunLimitError(Exception):
    pass


@dataclass
class Run:
    id: str
    goal: str
    scenario: str
    status: str = "queued"
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    result: dict | None = None
    error: str | None = None
    log: EventLog = field(init=False)
    task: asyncio.Task | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        self.log = EventLog(self.id)

    @property
    def active(self) -> bool:
        return self.status in ACTIVE

    def summary(self) -> dict:
        return {
            "id": self.id, "goal": self.goal, "scenario": self.scenario, "status": self.status,
            "created_at": self.created_at, "started_at": self.started_at, "finished_at": self.finished_at,
            "result": self.result, "error": self.error, "event_count": len(self.log.events),
        }


class RunManager:
    def __init__(self, settings: Settings, model_factory: Callable[[], Model] | None = None,
                 runs_dir: Path | None = None, agent_kwargs: dict | None = None):
        self.settings = settings
        self.model_factory = model_factory or (lambda: GeminiModel(settings.gemini_api_key, settings.gemini_model))
        self.runs_dir = runs_dir or settings.runs_dir
        self.agent_kwargs = agent_kwargs or {}
        self.runs: dict[str, Run] = {}

    def get(self, run_id: str) -> Run | None:
        return self.runs.get(run_id)

    def start(self, goal: str, scenario: str) -> Run:
        active = sum(r.active for r in self.runs.values())
        if active >= self.settings.max_concurrent_runs:
            raise RunLimitError(f"too many active runs ({active}); try again later")
        self._evict()
        run = Run(id=new_run_id(), goal=goal, scenario=scenario)
        self.runs[run.id] = run
        run.task = asyncio.create_task(self._execute(run), name=f"run-{run.id}")
        run.task.add_done_callback(lambda _t, r=run: self._finalize_unstarted(r))
        return run

    @staticmethod
    def _finalize_unstarted(run: Run) -> None:
        # A task cancelled before its first step never runs _execute's body.
        if run.active:
            run.status, run.finished_at = "cancelled", time.time()
            run.log.emit(ev.RUN_CANCELLED, reason="cancelled before start")

    def cancel(self, run: Run) -> bool:
        if not run.active or run.task is None:
            return False
        run.task.cancel()
        return True

    async def shutdown(self) -> None:
        """Cancel active runs and wait for every unfinished task (incl. ones still cleaning up)."""
        for r in self.runs.values():
            if r.active and r.task:
                r.task.cancel()
        tasks = [r.task for r in self.runs.values() if r.task and not r.task.done()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def _evict(self) -> None:
        finished = sorted((r for r in self.runs.values() if not r.active), key=lambda r: r.created_at)
        while len(self.runs) >= MAX_STORED_RUNS and finished:
            self.runs.pop(finished.pop(0).id, None)

    async def _execute(self, run: Run) -> None:
        run.status, run.started_at = "running", time.time()
        app_dir: Path | None = None
        try:
            # Workspace creation is blocking file I/O; keep the event loop free. If cancelled
            # meanwhile, wait for the thread so the created workspace is known and cleaned up.
            create = asyncio.ensure_future(asyncio.to_thread(create_workspace, run.scenario, run.id, self.runs_dir))
            try:
                app_dir = await asyncio.shield(create)
            except asyncio.CancelledError:
                app_dir = await create if not create.cancelled() else None
                raise
            model = self.model_factory()
            async with MCPManager(app_dir) as mcp:
                agent = RecoveryAgent(mcp, model, run.log, self.settings, **self.agent_kwargs)
                result = await agent.run(run.goal)  # emits run_completed / run_failed
                # Set synchronously after the terminal event (no await in between), so a client
                # that sees the event never reads a stale status while MCP servers shut down.
                run.result, run.status, run.finished_at = result.to_dict(), result.status, time.time()
        except asyncio.CancelledError:
            # Swallowed so shutdown/gather see a clean result. If the run already reached a
            # terminal state (cancel hit MCP teardown), keep that outcome.
            if not run.log.closed:
                run.status, run.finished_at = "cancelled", time.time()
                run.log.emit(ev.RUN_CANCELLED, reason="cancelled by user")
        except Exception as e:  # noqa: BLE001 - setup failures (workspace, MCP, model config)
            if not run.log.closed:  # errors after the terminal event (teardown) don't change the outcome
                run.status, run.error, run.finished_at = "failed", f"{type(e).__name__}: {str(e)[:300]}", time.time()
                run.log.emit(ev.RUN_FAILED, status="failed", reason=run.error)
        finally:
            run.finished_at = run.finished_at or time.time()
            if app_dir is not None:
                try:
                    await asyncio.to_thread(delete_workspace, app_dir, self.runs_dir)
                except OSError:
                    pass
