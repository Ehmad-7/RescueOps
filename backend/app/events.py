"""Agent lifecycle events: an append-only, subscribable log per run (SSE-ready)."""
from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, dataclass, field
from typing import Any, AsyncIterator

# Event types
RUN_STARTED = "run_started"
PLAN_UPDATED = "plan_updated"
AGENT_STATUS = "agent_status"          # concise model-authored status text, never thoughts
TOOL_STARTED = "tool_started"
TOOL_COMPLETED = "tool_completed"
TOOL_FAILED = "tool_failed"
VERIFICATION_STARTED = "verification_started"
VERIFICATION_COMPLETED = "verification_completed"
RUN_COMPLETED = "run_completed"
RUN_FAILED = "run_failed"
RUN_CANCELLED = "run_cancelled"
TERMINAL = {RUN_COMPLETED, RUN_FAILED, RUN_CANCELLED}


@dataclass(frozen=True)
class Event:
    seq: int
    type: str
    ts: float
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


class EventLog:
    """Append-only event log per run; readers replay from any seq and wait for new events."""

    def __init__(self, run_id: str):
        self.run_id = run_id
        self.events: list[Event] = []
        self._changed = asyncio.Event()

    @property
    def closed(self) -> bool:
        return bool(self.events) and self.events[-1].type in TERMINAL

    def emit(self, type_: str, **data: Any) -> Event:
        ev = Event(seq=len(self.events), type=type_, ts=round(time.time(), 3), data=data)
        self.events.append(ev)
        self._changed.set()
        self._changed = asyncio.Event()
        return ev

    def since(self, after: int) -> list[Event]:
        return self.events[max(after + 1, 0):]

    async def wait(self, after: int, timeout: float) -> list[Event]:
        """Events with seq > after; waits up to `timeout` for new ones (empty list on timeout)."""
        if not self.since(after) and not self.closed:
            changed = self._changed
            try:
                await asyncio.wait_for(changed.wait(), timeout)
            except TimeoutError:
                pass
        return self.since(after)

    async def subscribe(self, after: int = -1, heartbeat: float | None = None) -> AsyncIterator[Event | None]:
        """Yield events with seq > after (replay, then live) until a terminal event.

        With `heartbeat`, yields None after that many idle seconds (for SSE keep-alives).
        """
        while True:
            batch = await self.wait(after, heartbeat if heartbeat else 3600)
            if not batch:
                if self.closed:  # caller is already past the terminal event
                    return
                if heartbeat:
                    yield None
                continue
            for ev in batch:
                after = ev.seq
                yield ev
                if ev.type in TERMINAL:
                    return
