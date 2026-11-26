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
TERMINAL = {RUN_COMPLETED, RUN_FAILED}


@dataclass(frozen=True)
class Event:
    seq: int
    type: str
    ts: float
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


class EventLog:
    """Keeps every event (for replay) and fans out new ones to live subscribers."""

    def __init__(self, run_id: str):
        self.run_id = run_id
        self.events: list[Event] = []
        self._subscribers: list[asyncio.Queue[Event]] = []

    @property
    def closed(self) -> bool:
        return bool(self.events) and self.events[-1].type in TERMINAL

    def emit(self, type_: str, **data: Any) -> Event:
        ev = Event(seq=len(self.events), type=type_, ts=round(time.time(), 3), data=data)
        self.events.append(ev)
        for q in self._subscribers:
            q.put_nowait(ev)
        return ev

    async def subscribe(self, after: int = -1) -> AsyncIterator[Event]:
        """Yield past events with seq > after, then live ones until a terminal event."""
        q: asyncio.Queue[Event] = asyncio.Queue()
        self._subscribers.append(q)
        try:
            backlog = [e for e in self.events if e.seq > after]
            for ev in backlog:
                yield ev
                if ev.type in TERMINAL:
                    return
            last = backlog[-1].seq if backlog else after
            while True:
                ev = await q.get()
                if ev.seq <= last:
                    continue
                yield ev
                if ev.type in TERMINAL:
                    return
        finally:
            self._subscribers.remove(q)
