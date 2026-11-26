"""Agent loop tests: scripted model, REAL MCP servers and tools on a real workspace."""
import json
import subprocess

import anyio
import pytest
from google.genai import errors as genai_errors
from google.genai import types

from app import events as ev
from app.agent import RecoveryAgent
from app.config import get_settings
from app.events import EventLog
from app.mcp_bridge import MCPManager
from app.workspace import create_workspace

GOAL = "Investigate why my application is broken and recover it."
FIX = {"path": "inventory.py", "edits": [{"oldText": 'item["quantity"]', "newText": 'item["qty"]'}]}
PLAN = {"steps": [{"step": "Inspect status and logs", "status": "in_progress"},
                  {"step": "Repair and verify", "status": "pending"}]}


def call(name, **args):
    return types.Part(function_call=types.FunctionCall(id=f"c-{name}", name=name, args=args))


def text(t, thought=False):
    return types.Part(text=t, thought=thought or None)


def resp(*parts):
    return types.GenerateContentResponse(candidates=[types.Candidate(
        content=types.Content(role="model", parts=list(parts)))])


class ScriptedModel:
    """Returns scripted turns; each item is a response, an Exception, or a callable(contents)."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = 0
        self.seen: list[list[types.Content]] = []

    async def generate(self, contents, config):
        self.calls += 1
        self.seen.append(list(contents))
        assert config.automatic_function_calling.disable is True
        item = self.script.pop(0) if self.script else resp(call("get_app_status"))
        if callable(item):
            item = await item(contents)
        if isinstance(item, Exception):
            raise item
        return item


def observations(model):
    """All function responses the model was shown, by tool name."""
    out = {}
    for c in model.seen[-1]:
        for p in c.parts or []:
            if p.function_response:
                out.setdefault(p.function_response.name, []).append(p.function_response.response)
    return out


def types_of(log):
    return [e.type for e in log.events]


@pytest.fixture
def ws(tmp_path):
    return create_workspace("code-bug", "agent", runs_dir=tmp_path / "runs")


def run_agent(ws, model, **kw):
    log = EventLog("t")

    async def main():
        async with MCPManager(ws) as m:
            agent = RecoveryAgent(m, model, log, get_settings(), retry_delay=0, **kw)
            return await agent.run(GOAL)

    return anyio.run(main), log


def no_app_running(ws):
    out = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True).stdout
    return str(ws) not in out and "app.py" not in [l.split()[-1] for l in out.splitlines() if l.strip()]


def test_dynamic_tools_repair_and_independent_verification(ws):
    model = ScriptedModel([
        resp(text("Planning the investigation."), call("update_plan", **PLAN)),
        resp(text("Checking whether the service starts."), call("start_app")),
        resp(call("read_logs", lines=40), call("read_text_file", path="inventory.py")),
        resp(text("Wrong key in total_value; fixing it."), call("edit_file", **FIX)),
        resp(call("finish", status="recovered", root_cause="KeyError: wrong key in inventory.py",
                  summary="Fixed key", evidence=["KeyError: 'quantity' in logs"])),
    ])
    result, log = run_agent(ws, model)
    assert result.status == "verified", result
    assert result.verification["passed"] and result.verification["tests"]["ok"]
    assert result.root_cause.startswith("KeyError") and result.plan[0]["status"] == "in_progress"
    t = types_of(log)
    assert t[0] == ev.RUN_STARTED and t[-1] == ev.RUN_COMPLETED
    assert ev.PLAN_UPDATED in t and ev.VERIFICATION_STARTED in t and ev.VERIFICATION_COMPLETED in t
    tools = [e.data["tool"] for e in log.events if e.type == ev.TOOL_STARTED]
    assert tools == ["start_app", "read_logs", "read_text_file", "edit_file"]
    # the model was fed real observations, e.g. the actual crash in the logs
    assert "KeyError" in json.dumps(model.seen[3][-1].model_dump(), default=str)
    assert 'item["qty"]' in (ws / "inventory.py").read_text()
    assert no_app_running(ws)


def test_tool_failure_is_observed_and_agent_replans(ws):
    model = ScriptedModel([
        resp(call("update_plan", **PLAN)),
        resp(call("read_text_file", path="src/inventory.py")),           # wrong guess -> real error
        resp(call("update_plan", steps=[{"step": "Locate module", "status": "in_progress"}]),
             call("search_files", path=".", pattern="**/*.py")),
        resp(call("edit_file", **FIX)),
        resp(call("finish", status="recovered", root_cause="bad key", summary="fixed")),
    ])
    result, log = run_agent(ws, model)
    assert result.status == "verified"
    failed = [e for e in log.events if e.type == ev.TOOL_FAILED]
    assert failed and failed[0].data["tool"] == "read_text_file"
    shown = model.seen[2][-1].parts[0].function_response.response
    assert shown["ok"] is False and shown["error"]
    assert [e for e in log.events if e.type == ev.PLAN_UPDATED][-1].data["plan"][0]["step"] == "Locate module"


def test_finish_without_fix_fails_verification_and_returns_control(ws):
    model = ScriptedModel([
        resp(call("finish", status="recovered", root_cause="guess", summary="nothing done")),
        resp(text("Verification failed; investigating."), call("read_logs")),
        resp(call("edit_file", **FIX)),
        resp(call("finish", status="recovered", root_cause="bad key", summary="fixed")),
    ])
    result, log = run_agent(ws, model)
    assert result.status == "verified"
    done = [e.data for e in log.events if e.type == ev.VERIFICATION_COMPLETED]
    assert [d["passed"] for d in done] == [False, True]
    first_obs = model.seen[1][-1].parts[0].function_response.response
    assert first_obs["verified"] is False and first_obs["verification"]["tests"]["ok"] is False


def test_unverified_after_repeated_false_finishes(ws):
    fin = resp(call("finish", status="recovered", root_cause="x", summary="y"))
    result, log = run_agent(ws, ScriptedModel([fin, fin, fin]))
    assert result.status == "unverified" and types_of(log)[-1] == ev.RUN_FAILED


def test_step_limit(ws):
    model = ScriptedModel([resp(call("get_app_status"))] * 10)
    result, _ = run_agent(ws, model, max_steps=3)
    assert result.status == "failed" and "step limit" in result.reason and model.calls == 3


def test_tool_budget(ws):
    model = ScriptedModel([resp(call("get_app_status"))] * 4)
    result, log = run_agent(ws, model, max_steps=4, max_tool_calls=2)
    assert len([e for e in log.events if e.type == ev.TOOL_STARTED]) == 2
    assert "budget" in json.dumps(observations(model)["get_app_status"][-1])


def test_safety_and_malformed_calls_are_observations(ws, tmp_path):
    (tmp_path / "secret.txt").write_text("s3cret")
    model = ScriptedModel([
        resp(call("run_shell", cmd="rm -rf /"),
             call("read_text_file", path=str(tmp_path / "secret.txt")),
             call("write_file", path="tests/test_app.py", content="pass"),
             call("update_plan", steps="not-a-list")),
        resp(call("finish", status="failed", root_cause="n/a", summary="stopping")),
    ])
    result, log = run_agent(ws, model)
    obs = observations(model)
    assert "disallowed" in obs["run_shell"][0]["error"]
    assert "blocked" in obs["read_text_file"][0]["error"]
    assert "not permitted" in obs["write_file"][0]["error"]
    assert obs["update_plan"][0]["ok"] is False
    assert "s3cret" not in json.dumps([e.to_dict() for e in log.events])
    assert result.status == "failed" and result.reason == "agent reported recovery impossible"


def test_thoughts_are_never_emitted(ws):
    model = ScriptedModel([
        resp(text("PRIVATE REASONING", thought=True), text("Checking status."), call("get_app_status")),
        resp(call("finish", status="failed", root_cause="n/a", summary="n/a")),
    ])
    _, log = run_agent(ws, model)
    dump = json.dumps([e.to_dict() for e in log.events])
    assert "PRIVATE REASONING" not in dump and "Checking status." in dump


def test_idle_model_is_nudged_then_stopped(ws):
    model = ScriptedModel([resp(text("Hmm.")), resp(text("Still thinking.")), resp(text("..."))])
    result, _ = run_agent(ws, model)
    assert result.status == "failed" and "without finishing" in result.reason and model.calls == 3


def test_transient_gemini_errors_retry_then_fail(ws):
    err = genai_errors.ServerError(503, {"error": {"message": "overloaded", "status": "UNAVAILABLE"}})
    model = ScriptedModel([err, err, err])
    result, log = run_agent(ws, model)
    assert result.status == "failed" and "Gemini API error" in result.reason and model.calls == 3
    assert types_of(log)[-1] == ev.RUN_FAILED


def test_transient_error_recovers(ws):
    err = genai_errors.ClientError(429, {"error": {"message": "rate", "status": "RESOURCE_EXHAUSTED"}})
    model = ScriptedModel([err, resp(call("finish", status="failed", root_cause="n/a", summary="n/a"))])
    result, _ = run_agent(ws, model)
    assert result.reason == "agent reported recovery impossible" and model.calls == 2


def test_non_transient_gemini_error_fails_fast(ws):
    err = genai_errors.ClientError(400, {"error": {"message": "bad request", "status": "INVALID_ARGUMENT"}})
    model = ScriptedModel([err, err])
    result, _ = run_agent(ws, model)
    assert result.status == "failed" and model.calls == 1


def test_run_timeout_cleans_up_running_app(ws):
    (ws / "inventory.py").write_text((ws / "inventory.py").read_text().replace('item["quantity"]', 'item["qty"]'))

    async def hang(_):
        await anyio.sleep(60)

    model = ScriptedModel([resp(call("start_app")), hang])
    result, log = run_agent(ws, model, run_timeout_s=3)
    started = [e for e in log.events if e.type == ev.TOOL_COMPLETED and e.data["tool"] == "start_app"]
    assert started and started[0].data["result"]["ok"] is True  # app really was running
    assert result.status == "failed" and "timeout" in result.reason
    assert types_of(log)[-1] == ev.RUN_FAILED
    assert no_app_running(ws)


def test_event_log_subscription_replays_and_streams():
    log = EventLog("r")
    log.emit(ev.RUN_STARTED, goal="g")

    async def main():
        got = []

        async def consume():
            async for e in log.subscribe():
                got.append(e.type)

        async with anyio.create_task_group() as tg:
            tg.start_soon(consume)
            await anyio.sleep(0.05)
            log.emit(ev.TOOL_STARTED, tool="x")
            log.emit(ev.RUN_COMPLETED)
        return got

    assert anyio.run(main) == [ev.RUN_STARTED, ev.TOOL_STARTED, ev.RUN_COMPLETED]
    assert log.closed
