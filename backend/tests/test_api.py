"""Runs API + SSE tests (scripted model, real workspaces and MCP servers)."""
import dataclasses
import json
import time

import anyio
import pytest
from fastapi.testclient import TestClient

import app.main as main_mod
from app.config import get_settings
from app.main import app
from app.runs import RunManager
from tests.test_agent import FIX, PLAN, ScriptedModel, call, no_app_running, resp


def fixing_script():
    return [
        resp(call("update_plan", **PLAN)),
        resp(call("start_app")),
        resp(call("read_logs", lines=30)),
        resp(call("edit_file", **FIX)),
        resp(call("finish", status="recovered", root_cause="bad key", summary="fixed")),
    ]


async def _hang(_):
    await anyio.sleep(120)


@pytest.fixture
def make_client(tmp_path):
    clients = []

    def _make(script_factory=fixing_script, *, configured=True, max_concurrent=2,
              model_factory=None, agent_kwargs=None):
        settings = dataclasses.replace(
            get_settings(), gemini_api_key="test-key" if configured else "",
            max_concurrent_runs=max_concurrent)
        factory = model_factory or (lambda: ScriptedModel(script_factory()))
        app.state.runs = RunManager(settings, model_factory=factory, runs_dir=tmp_path / "runs",
                                    agent_kwargs=agent_kwargs)
        c = TestClient(app)
        c.__enter__()
        clients.append(c)
        return c

    yield _make
    for c in clients:
        c.__exit__(None, None, None)
    if hasattr(app.state, "runs"):
        del app.state.runs


def read_sse(client, run_id, headers=None, params=None):
    """Return (events, raw_text) for a stream that ends at a terminal event."""
    with client.stream("GET", f"/runs/{run_id}/events", headers=headers or {}, params=params or {}) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        raw = "".join(r.iter_text())
    events = []
    for block in raw.split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line and not line.startswith(":"))
        if "data" in fields:
            events.append({"id": int(fields["id"]), "event": fields["event"], **json.loads(fields["data"])})
    return events, raw


def wait_status(client, run_id, statuses, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        body = client.get(f"/runs/{run_id}").json()
        if body["status"] in statuses:
            return body
        time.sleep(0.1)
    raise AssertionError(f"run did not reach {statuses}: {body}")


def wait_done(run_id, timeout=30):
    """Wait until the run task (including workspace/MCP cleanup) has fully finished."""
    end = time.time() + timeout
    while time.time() < end:
        if app.state.runs.get(run_id).task.done():
            return
        time.sleep(0.05)
    raise AssertionError("run task did not finish")


def wait_event(client, run_id, event_type, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        run = app.state.runs.get(run_id)
        if any(e.type == event_type for e in run.log.events):
            return
        time.sleep(0.05)
    raise AssertionError(f"no {event_type} event")


# ------------------------------------------------------------------ validation / errors
def test_validation_and_not_found(make_client):
    c = make_client()
    assert c.get("/scenarios").json()[0]["id"] == "bad-config"
    assert c.post("/runs", json={}).status_code == 422
    assert c.post("/runs", json={"scenario": "nope"}).status_code == 422
    assert c.post("/runs", json={"scenario": "code-bug", "goal": "x" * 501}).status_code == 422
    assert c.get("/runs/doesnotexist").status_code == 404
    assert c.get("/runs/BAD!").status_code == 404
    assert c.get("/runs/doesnotexist/events").status_code == 404
    assert c.post("/runs/doesnotexist/cancel").status_code == 404


def test_requires_gemini_key(make_client):
    c = make_client(configured=False)
    r = c.post("/runs", json={"scenario": "code-bug"})
    assert r.status_code == 503 and "test-key" not in r.text


# ------------------------------------------------------------------ full lifecycle
def test_run_lifecycle_streams_and_verifies(make_client, tmp_path):
    c = make_client()
    r = c.post("/runs", json={"scenario": "code-bug"})
    assert r.status_code == 202
    body = r.json()
    run_id = body["id"]
    assert body["status"] in ("queued", "running") and body["events_url"] == f"/runs/{run_id}/events"
    events, raw = read_sse(c, run_id)
    # status is final as soon as the terminal event has been streamed (no race)
    assert c.get(f"/runs/{run_id}").json()["status"] == "verified"
    assert raw.startswith("retry: 3000")
    assert [e["id"] for e in events] == list(range(len(events)))
    kinds = [e["event"] for e in events]
    assert kinds[0] == "run_started" and kinds[-1] == "run_completed"
    assert {"plan_updated", "tool_started", "tool_completed", "verification_completed"} <= set(kinds)
    final = wait_status(c, run_id, {"verified"})
    assert final["result"]["verification"]["passed"] is True
    assert final["plan"] and final["finished_at"] >= final["started_at"]
    assert final["event_count"] == len(events)
    wait_done(run_id)
    assert not (tmp_path / "runs" / run_id).exists()  # workspace cleaned up
    assert "test-key" not in raw


def test_replay_after_and_last_event_id(make_client):
    c = make_client()
    run_id = c.post("/runs", json={"scenario": "code-bug"}).json()["id"]
    wait_status(c, run_id, {"verified"})
    full, _ = read_sse(c, run_id)
    resumed, _ = read_sse(c, run_id, headers={"Last-Event-ID": "3"})
    assert [e["id"] for e in resumed] == [e["id"] for e in full][4:]
    via_query, _ = read_sse(c, run_id, params={"after": 5})
    assert via_query[0]["id"] == 6 and via_query[-1]["event"] == "run_completed"
    # header wins over query; past the end → stream closes immediately with no events
    tail, raw = read_sse(c, run_id, headers={"Last-Event-ID": str(full[-1]["id"])}, params={"after": 0})
    assert tail == [] and raw.strip() == "retry: 3000"
    bogus, _ = read_sse(c, run_id, headers={"Last-Event-ID": "abc"})
    assert len(bogus) == len(full)
    assert c.get(f"/runs/{run_id}/events", params={"after": -5}).status_code == 422


# ------------------------------------------------------------------ cancellation / limits
def test_cancel_running_run(make_client, tmp_path):
    c = make_client(lambda: [resp(call("start_app")), _hang])
    run_id = c.post("/runs", json={"scenario": "bad-config"}).json()["id"]
    wait_event(c, run_id, "tool_completed")
    r = c.post(f"/runs/{run_id}/cancel")
    assert r.status_code == 202 and r.json()["status"] == "cancelling"
    final = wait_status(c, run_id, {"cancelled"})
    assert final["finished_at"]
    events, _ = read_sse(c, run_id)
    assert events[-1]["event"] == "run_cancelled"
    assert c.post(f"/runs/{run_id}/cancel").status_code == 409
    wait_done(run_id)
    assert not (tmp_path / "runs" / run_id).exists()
    assert no_app_running(tmp_path / "runs" / run_id)


def test_cancel_finished_run_conflicts(make_client):
    c = make_client()
    run_id = c.post("/runs", json={"scenario": "code-bug"}).json()["id"]
    wait_status(c, run_id, {"verified"})
    r = c.post(f"/runs/{run_id}/cancel")
    assert r.status_code == 409 and "verified" in r.json()["detail"]


def test_concurrency_limit(make_client):
    c = make_client(lambda: [_hang], max_concurrent=1)
    first = c.post("/runs", json={"scenario": "code-bug"}).json()["id"]
    r = c.post("/runs", json={"scenario": "code-bug"})
    assert r.status_code == 429
    c.post(f"/runs/{first}/cancel")
    wait_status(c, first, {"cancelled"})
    assert c.post("/runs", json={"scenario": "code-bug"}).status_code == 202


def test_setup_failure_marks_run_failed(make_client):
    def broken_factory():
        raise ValueError("model init failed")

    c = make_client(model_factory=broken_factory)
    run_id = c.post("/runs", json={"scenario": "code-bug"}).json()["id"]
    final = wait_status(c, run_id, {"failed"})
    assert "model init failed" in final["error"]
    events, _ = read_sse(c, run_id)
    assert events[-1]["event"] == "run_failed"


def test_agent_failure_status_and_heartbeat(make_client, monkeypatch):
    monkeypatch.setattr(main_mod, "SSE_HEARTBEAT_S", 0.2)
    c = make_client(lambda: [_hang], agent_kwargs={"run_timeout_s": 1.5})
    run_id = c.post("/runs", json={"scenario": "code-bug"}).json()["id"]
    events, raw = read_sse(c, run_id)
    assert ": keep-alive" in raw
    assert events[-1]["event"] == "run_failed" and "timeout" in events[-1]["data"]["reason"]
    assert wait_status(c, run_id, {"failed"})["result"]["status"] == "failed"


def test_shutdown_cancels_active_runs(make_client):
    c = make_client(lambda: [_hang])
    run_id = c.post("/runs", json={"scenario": "code-bug"}).json()["id"]
    wait_event(c, run_id, "run_started")
    manager = app.state.runs
    c.__exit__(None, None, None)  # lifespan shutdown
    run = manager.get(run_id)
    assert run.status == "cancelled" and run.log.events[-1].type == "run_cancelled"
