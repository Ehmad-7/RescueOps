import json
import re
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import get_settings
from app.runs import RunLimitError, RunManager
from app.workspace import SCENARIOS

settings = get_settings()
DEFAULT_GOAL = "Investigate why my application is broken and recover it."
SSE_HEARTBEAT_S = 15.0
_RUN_ID_RE = re.compile(r"^[a-z0-9-]{1,64}$")
_EVENT_ID_RE = re.compile(r"-?[0-9]{1,9}", re.ASCII)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not hasattr(app.state, "runs"):
        app.state.runs = RunManager(settings)
    yield
    await app.state.runs.shutdown()


app = FastAPI(title="RescueOps", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Last-Event-ID"],
)


class RunRequest(BaseModel):
    goal: str = Field(default=DEFAULT_GOAL, min_length=3, max_length=500)
    scenario: str = Field(description="Failure scenario to inject into the fresh workspace")


def _runs(request: Request) -> RunManager:
    return request.app.state.runs


def _get_run(request: Request, run_id: str):
    run = _runs(request).get(run_id) if _RUN_ID_RE.match(run_id) else None
    if run is None:
        raise HTTPException(404, "run not found")
    return run


@app.get("/health")
def health() -> dict:
    # Never return secret values, only whether they are configured.
    return {
        "status": "ok",
        "version": app.version,
        "gemini_configured": settings.gemini_configured,
        "model": settings.gemini_model,
    }


@app.get("/scenarios")
def scenarios() -> list[dict]:
    return [{"id": k, "description": v[0]} for k, v in SCENARIOS.items()]


@app.post("/runs", status_code=202)
async def create_run(body: RunRequest, request: Request) -> dict:
    if body.scenario not in SCENARIOS:
        raise HTTPException(422, f"unknown scenario; expected one of {sorted(SCENARIOS)}")
    manager = _runs(request)
    if not manager.settings.gemini_configured:
        raise HTTPException(503, "Gemini API key is not configured on the server")
    try:
        run = manager.start(body.goal.strip(), body.scenario)
    except RunLimitError as e:
        raise HTTPException(429, str(e)) from e
    return {**run.summary(), "events_url": f"/runs/{run.id}/events"}


@app.get("/runs/{run_id}")
async def get_run(run_id: str, request: Request) -> dict:
    run = _get_run(request, run_id)
    return {**run.summary(), "plan": (run.result or {}).get("plan") or _latest_plan(run)}


@app.post("/runs/{run_id}/cancel", status_code=202)
async def cancel_run(run_id: str, request: Request) -> dict:
    run = _get_run(request, run_id)
    if not _runs(request).cancel(run):
        raise HTTPException(409, f"run is already {run.status}")
    return {"id": run.id, "status": "cancelling"}


@app.get("/runs/{run_id}/events")
async def run_events(run_id: str, request: Request,
                     after: int | None = Query(default=None, ge=-1),
                     last_event_id: str | None = Header(default=None)) -> StreamingResponse:
    run = _get_run(request, run_id)
    start = -1
    resume = _parse_event_id(last_event_id)
    if resume is not None:
        start = resume  # browser reconnect: resume after the last seen event
    elif after is not None:
        start = after

    async def stream() -> AsyncIterator[str]:
        yield "retry: 3000\n\n"
        async for event in run.log.subscribe(after=start, heartbeat=SSE_HEARTBEAT_S):
            if await request.is_disconnected():
                return
            if event is None:
                yield ": keep-alive\n\n"
                continue
            data = json.dumps(event.to_dict(), default=str)
            yield f"id: {event.seq}\nevent: {event.type}\ndata: {data}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


def _parse_event_id(value: str | None) -> int | None:
    """Strict ASCII integer (bounded length); anything else is ignored → full replay."""
    if value is None:
        return None
    value = value.strip()
    if not _EVENT_ID_RE.fullmatch(value):
        return None
    return max(int(value), -1)


def _latest_plan(run) -> list:
    for e in reversed(run.log.events):
        if e.type == "plan_updated":
            return e.data.get("plan", [])
    return []
