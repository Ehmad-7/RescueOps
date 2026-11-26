"""Autonomous recovery agent: Gemini function calling over the run's MCP tools.

The loop is model-driven: each turn Gemini sees the goal, history and real tool
observations and chooses which tool(s) to call next. The backend only executes,
enforces limits, and independently verifies when the model calls `finish`.
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol

import anyio
from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from app import events as ev
from app.config import Settings
from app.events import EventLog
from app.mcp_bridge import MCPManager

MAX_OBSERVATION_CHARS = 6000
MAX_STATUS_CHARS = 400
MAX_CALLS_PER_TURN = 6
MAX_VERIFY_ATTEMPTS = 3
MAX_IDLE_TURNS = 2           # model turns with no tool call before giving up
MODEL_RETRIES = 2
MODEL_CALL_TIMEOUT = 90.0
TOOL_CALL_TIMEOUT = 45.0
PLAN_STATUSES = ("pending", "in_progress", "done", "failed", "skipped")

SYSTEM_PROMPT = """You are RescueOps, an autonomous DevOps recovery agent.
You operate on one service inside an isolated workspace, using only the provided tools.
Paths are relative to the workspace root ('.').

How to work:
- First call update_plan with a short investigation/recovery plan. Revise it (update_plan) whenever
  you learn something that changes the plan or a step fails.
- Gather evidence before changing anything: status, logs, config, code, tests.
- Diagnose the root cause from real tool output. Make the smallest correct repair.
- After repairing, restart the service and check it yourself.
- If an action fails or a check is still red, read the error and try a different approach.
- Files under tests/ and logs/ are read-only: fix the service, never the checks.
- When you believe the service is recovered, call finish. The system then independently verifies
  (restart + health check + tests). If verification fails you will get the results and must continue.
- If recovery is impossible with the available tools, call finish with status "failed" and explain.
- Alongside tool calls, write at most one short sentence stating what you are doing and why.
  Never invent tool results."""

CONTROL_TOOLS = [
    types.FunctionDeclaration(
        name="update_plan",
        description="Create or revise the recovery plan. Send the full plan each time (max 8 steps).",
        parameters=types.Schema(
            type=types.Type.OBJECT,
            properties={"steps": types.Schema(
                type=types.Type.ARRAY, min_items=1, max_items=8,
                items=types.Schema(type=types.Type.OBJECT, properties={
                    "step": types.Schema(type=types.Type.STRING, description="Short action description"),
                    "status": types.Schema(type=types.Type.STRING, enum=list(PLAN_STATUSES)),
                }, required=["step", "status"]))},
            required=["steps"]),
    ),
    types.FunctionDeclaration(
        name="finish",
        description="Declare the task complete (or impossible). Triggers independent verification.",
        parameters=types.Schema(
            type=types.Type.OBJECT,
            properties={
                "status": types.Schema(type=types.Type.STRING, enum=["recovered", "failed"]),
                "root_cause": types.Schema(type=types.Type.STRING, description="Diagnosed root cause"),
                "summary": types.Schema(type=types.Type.STRING, description="What was done"),
                "evidence": types.Schema(type=types.Type.ARRAY, items=types.Schema(type=types.Type.STRING),
                                         description="Key observations supporting the diagnosis"),
            },
            required=["status", "root_cause", "summary"]),
    ),
]
CONTROL_NAMES = {d.name for d in CONTROL_TOOLS}


# --------------------------------------------------------------------------- model abstraction
class Model(Protocol):
    async def generate(self, contents: list[types.Content],
                       config: types.GenerateContentConfig) -> types.GenerateContentResponse: ...


class GeminiModel:
    def __init__(self, api_key: str, model: str):
        if not api_key:
            raise ValueError("GEMINI_API_KEY is not configured")
        self.model = model
        # SDK-level retries disabled: the agent loop owns retry/backoff within the run deadline.
        self._client = genai.Client(api_key=api_key, http_options=types.HttpOptions(
            timeout=int(MODEL_CALL_TIMEOUT * 1000), retry_options=types.HttpRetryOptions(attempts=1)))

    async def generate(self, contents, config):
        return await self._client.aio.models.generate_content(model=self.model, contents=contents, config=config)


# --------------------------------------------------------------------------- results
@dataclass
class RunResult:
    status: str                      # "verified" | "unverified" | "failed"
    reason: str
    steps: int = 0
    tool_calls: int = 0
    root_cause: str | None = None
    summary: str | None = None
    evidence: list[str] = field(default_factory=list)
    verification: dict | None = None
    plan: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


class _Stop(Exception):
    def __init__(self, result: RunResult):
        self.result = result


def _clip(obj: Any, limit: int = MAX_OBSERVATION_CHARS) -> Any:
    """Bound observation size fed back to the model."""
    text = json.dumps(obj, default=str)
    if len(text) <= limit:
        return obj
    return {"truncated": True, "preview": text[:limit]}


def _short(text: str, limit: int = MAX_STATUS_CHARS) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _transient(e: Exception) -> bool:
    if isinstance(e, genai_errors.ServerError):
        return True
    return isinstance(e, genai_errors.ClientError) and getattr(e, "code", None) == 429


# --------------------------------------------------------------------------- agent
class RecoveryAgent:
    def __init__(self, mcp: MCPManager, model: Model, log: EventLog, settings: Settings, *,
                 max_steps: int | None = None, max_tool_calls: int | None = None,
                 run_timeout_s: float | None = None, retry_delay: float = 2.0):
        self.mcp = mcp
        self.model = model
        self.log = log
        self.max_steps = max_steps or settings.max_agent_steps
        self.max_tool_calls = max_tool_calls or settings.max_tool_calls
        self.run_timeout_s = run_timeout_s or settings.run_timeout_s
        self.retry_delay = retry_delay
        self.plan: list[dict] = []
        self.steps = 0
        self.tool_calls = 0
        self.verify_attempts = 0
        self.deadline = 0.0
        self.contents: list[types.Content] = []
        tool = types.Tool(function_declarations=mcp.function_declarations() + CONTROL_TOOLS)
        self.config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT, tools=[tool], temperature=0.2,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            tool_config=types.ToolConfig(function_calling_config=types.FunctionCallingConfig(
                mode=types.FunctionCallingConfigMode.AUTO)),
        )

    # ---- public
    async def run(self, goal: str) -> RunResult:
        self.deadline = time.monotonic() + self.run_timeout_s
        self.log.emit(ev.RUN_STARTED, goal=goal, max_steps=self.max_steps,
                      tools=sorted(self.mcp.tools) + sorted(CONTROL_NAMES))
        self.contents = [types.Content(role="user", parts=[types.Part(text=f"Goal: {goal}")])]
        try:
            with anyio.fail_after(self.run_timeout_s):
                result = await self._loop()
        except TimeoutError:
            result = self._result("failed", f"run timeout ({self.run_timeout_s:.0f}s) exceeded")
        except _Stop as s:
            result = s.result
        except Exception as e:  # noqa: BLE001 - never crash the server on agent bugs
            result = self._result("failed", f"internal error: {type(e).__name__}: {_short(str(e), 200)}")
        finally:
            with anyio.move_on_after(10, shield=True):
                await self.mcp.call("stop_app")  # leave no app process behind
        if result.status == "verified":
            self.log.emit(ev.RUN_COMPLETED, **result.to_dict())
        else:
            self.log.emit(ev.RUN_FAILED, **result.to_dict())
        return result

    # ---- loop
    async def _loop(self) -> RunResult:
        idle = 0
        while self.steps < self.max_steps:
            self.steps += 1
            resp = await self._generate()
            cand = (resp.candidates or [None])[0]
            content = cand.content if cand and cand.content else None
            if content is None or not content.parts:
                reason = getattr(cand, "finish_reason", None) if cand else None
                idle += 1
                if idle > MAX_IDLE_TURNS:
                    return self._result("failed", f"model returned no actionable output ({reason})")
                self._nudge("Your last response was empty. Continue: call a tool or finish.")
                continue
            self.contents.append(content)  # verbatim, preserves thought signatures
            texts = [p.text for p in content.parts if p.text and not p.thought]
            if texts:
                self.log.emit(ev.AGENT_STATUS, step=self.steps, text=_short(" ".join(texts)))
            calls = [p.function_call for p in content.parts if p.function_call]
            if not calls:
                idle += 1
                if idle > MAX_IDLE_TURNS:
                    return self._result("failed", "model stopped calling tools without finishing")
                self._nudge("No tool was called. Continue the recovery with a tool call, or call finish.")
                continue
            idle = 0
            responses: list[types.Part] = []
            outcome: RunResult | None = None
            for i, call in enumerate(calls):
                if i >= MAX_CALLS_PER_TURN:
                    payload = {"ok": False, "error": f"skipped: max {MAX_CALLS_PER_TURN} tool calls per turn"}
                elif outcome is not None:
                    payload = {"ok": False, "error": "skipped: run already finished"}
                else:
                    payload, outcome = await self._dispatch(call)
                responses.append(types.Part(function_response=types.FunctionResponse(
                    id=call.id, name=call.name or "unknown", response=_clip(payload))))
            self.contents.append(types.Content(role="user", parts=responses))
            if outcome is not None:
                return outcome
        return self._result("failed", f"step limit ({self.max_steps}) reached without verified recovery")

    async def _generate(self) -> types.GenerateContentResponse:
        last: Exception | None = None
        for attempt in range(MODEL_RETRIES + 1):
            try:
                with anyio.fail_after(min(MODEL_CALL_TIMEOUT, self._remaining())):
                    return await self.model.generate(self.contents, self.config)
            except TimeoutError as e:
                last = e
                if self._remaining() <= 0:
                    raise
            except Exception as e:  # noqa: BLE001
                last = e
                if not _transient(e):
                    break
            if attempt < MODEL_RETRIES:
                await anyio.sleep(min(self.retry_delay * (attempt + 1), max(self._remaining() - 1, 0)))
        raise _Stop(self._result("failed", f"Gemini API error: {type(last).__name__}: {_short(str(last), 200)}"))

    async def _dispatch(self, call: types.FunctionCall) -> tuple[dict, RunResult | None]:
        name = call.name or ""
        args = call.args if isinstance(call.args, dict) else None
        if args is None:
            args = {} if call.args is None else None
        if args is None:
            return self._tool_failed(name, {}, "malformed arguments: expected an object"), None
        if name == "update_plan":
            return self._update_plan(args), None
        if name == "finish":
            return await self._finish(args)
        if self.tool_calls >= self.max_tool_calls:
            return {"ok": False, "error": f"tool budget exhausted ({self.max_tool_calls}); call finish"}, None
        self.tool_calls += 1
        self.log.emit(ev.TOOL_STARTED, step=self.steps, tool=name, args=_clip(args, 1000))
        started = time.monotonic()
        mcp_timeout = min(TOOL_CALL_TIMEOUT, max(self._remaining(), 0.1))
        self.mcp.call_timeout = mcp_timeout
        result = await self.mcp.call(name, args)
        took = round(time.monotonic() - started, 2)
        if result.get("ok"):
            self.log.emit(ev.TOOL_COMPLETED, step=self.steps, tool=name, duration_s=took,
                          result=_clip(result.get("result"), 2000))
        else:
            self.log.emit(ev.TOOL_FAILED, step=self.steps, tool=name, duration_s=took,
                          error=_short(str(result.get("error")), 1000))
        return result, None

    def _tool_failed(self, name: str, args: dict, error: str) -> dict:
        self.log.emit(ev.TOOL_FAILED, step=self.steps, tool=name, args=args, error=error)
        return {"ok": False, "error": error}

    def _update_plan(self, args: dict) -> dict:
        steps = args.get("steps")
        if not isinstance(steps, list) or not steps:
            return self._tool_failed("update_plan", {}, "steps must be a non-empty list")
        plan = []
        for s in steps[:8]:
            if not isinstance(s, dict) or not isinstance(s.get("step"), str):
                return self._tool_failed("update_plan", {}, "each step needs a 'step' string")
            status = s.get("status") if s.get("status") in PLAN_STATUSES else "pending"
            plan.append({"step": _short(s["step"], 160), "status": status})
        self.plan = plan
        self.log.emit(ev.PLAN_UPDATED, step=self.steps, plan=plan)
        return {"ok": True, "plan_steps": len(plan)}

    async def _finish(self, args: dict) -> tuple[dict, RunResult | None]:
        claimed = args.get("status")
        info = dict(root_cause=_short(str(args.get("root_cause") or ""), 500) or None,
                    summary=_short(str(args.get("summary") or ""), 800) or None,
                    evidence=[_short(str(e), 200) for e in (args.get("evidence") or [])[:8]]
                    if isinstance(args.get("evidence"), list) else [])
        if claimed == "failed":
            return {"ok": True}, self._result("failed", "agent reported recovery impossible", **info)
        self.verify_attempts += 1
        verification = await self._verify()
        if verification["passed"]:
            return {"ok": True, "verified": True}, self._result(
                "verified", "independent verification passed", verification=verification, **info)
        if self.verify_attempts >= MAX_VERIFY_ATTEMPTS:
            return {"ok": False}, self._result(
                "unverified", f"verification failed {self.verify_attempts} times", verification=verification, **info)
        return {"ok": False, "verified": False,
                "message": "Independent verification FAILED. The service is not recovered. "
                           "Investigate the results below and continue.",
                "verification": verification}, None

    async def _verify(self) -> dict:
        """Backend-driven check, independent of the model's claim: clean restart, health, tests."""
        self.log.emit(ev.VERIFICATION_STARTED, step=self.steps, attempt=self.verify_attempts)
        self.mcp.call_timeout = min(TOOL_CALL_TIMEOUT, max(self._remaining(), 0.1))
        restart = await self.mcp.call("restart_app")
        health = await self.mcp.call("run_health_check")
        tests = await self.mcp.call("run_tests")
        r_ok = bool(restart.get("ok") and (restart.get("result") or {}).get("ok"))
        h_ok = bool(health.get("ok") and (health.get("result") or {}).get("healthy"))
        t_ok = bool(tests.get("ok") and (tests.get("result") or {}).get("passed"))
        verification = {
            "passed": r_ok and h_ok and t_ok,
            "restart": {"ok": r_ok, "detail": _clip(restart.get("result") or restart.get("error"), 1500)},
            "health": {"ok": h_ok, "detail": _clip(health.get("result") or health.get("error"), 1500)},
            "tests": {"ok": t_ok, "detail": _clip(tests.get("result") or tests.get("error"), 2500)},
        }
        self.log.emit(ev.VERIFICATION_COMPLETED, step=self.steps, attempt=self.verify_attempts,
                      passed=verification["passed"], restart=r_ok, health=h_ok, tests=t_ok)
        return verification

    # ---- helpers
    def _nudge(self, text: str) -> None:
        self.contents.append(types.Content(role="user", parts=[types.Part(text=text)]))

    def _remaining(self) -> float:
        return self.deadline - time.monotonic()

    def _result(self, status: str, reason: str, **kw: Any) -> RunResult:
        return RunResult(status=status, reason=reason, steps=self.steps, tool_calls=self.tool_calls,
                         plan=list(self.plan), **kw)


async def run_recovery(goal: str, mcp: MCPManager, log: EventLog, settings: Settings,
                       model: Model | None = None, **kw: Any) -> RunResult:
    model = model or GeminiModel(settings.gemini_api_key, settings.gemini_model)
    return await RecoveryAgent(mcp, model, log, settings, **kw).run(goal)
