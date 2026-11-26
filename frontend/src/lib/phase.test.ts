import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_TIMELINE, applyEvents, type AgentEvent, type EventType } from "./events.ts";
import { derivePhase, deriveStages } from "./phase.ts";
import { changesMade, resultSummary, toolLabel, toolTarget } from "./tools.ts";

let seq = 0;
const ev = (type: EventType, data: Record<string, unknown> = {}): AgentEvent => ({ seq: seq++, type, ts: 100 + seq, data });
const tl = (...events: AgentEvent[]) => applyEvents(EMPTY_TIMELINE, events);
const stages = (s: ReturnType<typeof deriveStages>) => Object.fromEntries(s.map((x) => [x.key, x.state]));

test("phase follows real events only", () => {
  seq = 0;
  assert.equal(derivePhase("queued", false, EMPTY_TIMELINE).key, "init");
  assert.equal(derivePhase("running", false, EMPTY_TIMELINE).key, "init", "no run_started yet");
  const started = tl(ev("run_started", { tools: [] }));
  assert.equal(derivePhase("running", false, started).key, "investigating");
  seq = 0;
  const planned = tl(ev("run_started"), ev("plan_updated", { plan: [{ step: "a", status: "pending" }] }));
  assert.equal(derivePhase("running", false, planned).label, "Plan ready");
  seq = 0;
  const executing = tl(ev("run_started"), ev("tool_started", { step: 1, tool: "read_logs" }));
  const p = derivePhase("running", false, executing);
  assert.equal(p.label, "Executing tool");
  assert.match(p.detail, /read_logs/);
  seq = 0;
  const repairing = tl(ev("run_started"), ev("tool_started", { step: 2, tool: "edit_file", args: { path: "x" } }));
  assert.equal(derivePhase("running", false, repairing).label, "Applying repair");
  seq = 0;
  const analyzing = tl(ev("run_started"), ev("tool_started", { step: 1, tool: "read_logs" }), ev("tool_completed", { step: 1, tool: "read_logs", result: {} }));
  assert.equal(derivePhase("running", false, analyzing).key, "analyzing");
  seq = 0;
  const replan = tl(ev("run_started"), ev("plan_updated", { plan: [] }), ev("plan_updated", { plan: [] }));
  assert.equal(derivePhase("running", false, replan).label, "Replanning");
  seq = 0;
  const verifying = tl(ev("run_started"), ev("verification_started", { attempt: 1 }));
  assert.equal(derivePhase("running", false, verifying).label, "Verifying recovery");
  seq = 0;
  const vfail = tl(ev("run_started"), ev("verification_started", { attempt: 1 }), ev("verification_completed", { attempt: 1, passed: false }));
  assert.equal(derivePhase("running", false, vfail).key, "verify-failed");
});

test("authoritative run status wins over the event stream", () => {
  seq = 0;
  const t = tl(ev("run_started"), ev("tool_started", { step: 1, tool: "run_tests" }));
  assert.equal(derivePhase("verified", false, t).key, "verified");
  assert.equal(derivePhase("unverified", false, t).tone, "warn");
  assert.equal(derivePhase("failed", false, t).tone, "bad");
  assert.equal(derivePhase("cancelled", false, t).key, "cancelled");
  assert.equal(derivePhase("running", true, t).key, "lost");
  seq = 0;
  const ended = tl(ev("run_started"), ev("run_completed", { status: "verified" }));
  assert.equal(derivePhase("running", false, ended).key, "finalizing", "terminal event before the summary poll");
});

test("stages reflect diagnose → repair → verify → result", () => {
  seq = 0;
  assert.deepEqual(stages(deriveStages("queued", false, EMPTY_TIMELINE)), { diagnose: "pending", repair: "pending", verify: "pending", result: "pending" });
  seq = 0;
  const diag = tl(ev("run_started"), ev("tool_started", { step: 1, tool: "read_logs" }));
  assert.equal(stages(deriveStages("running", false, diag)).diagnose, "active");
  seq = 0;
  const full = tl(
    ev("run_started"),
    ev("tool_started", { step: 2, tool: "edit_file", args: { path: "inventory.py" } }),
    ev("tool_completed", { step: 2, tool: "edit_file", result: "ok" }),
    ev("verification_started", { attempt: 1 }),
    ev("verification_completed", { attempt: 1, passed: true, restart: true, health: true, tests: true }),
  );
  assert.deepEqual(stages(deriveStages("verified", false, full)), { diagnose: "done", repair: "done", verify: "done", result: "done" });
  seq = 0;
  const noRepair = tl(ev("run_started"), ev("verification_started", { attempt: 1 }), ev("verification_completed", { attempt: 1, passed: false }));
  const s = stages(deriveStages("unverified", false, noRepair));
  assert.equal(s.repair, "skipped");
  assert.equal(s.verify, "failed");
  assert.equal(s.result, "failed");
  assert.equal(stages(deriveStages("cancelled", false, EMPTY_TIMELINE)).result, "skipped");
});

test("tool presentation is grounded in real payload fields", () => {
  assert.equal(toolLabel("edit_file"), "Edited file");
  assert.equal(toolLabel("some_new_tool"), "some_new_tool");
  assert.equal(toolTarget({ path: "inventory.py", edits: [] }), "inventory.py");
  assert.equal(toolTarget({ source: "data/items.json.bak", destination: "data/items.json" }), "data/items.json.bak → data/items.json");
  assert.equal(toolTarget({ path: ".", pattern: "**/*.py" }), "**/*.py in workspace root");
  assert.equal(toolTarget({ path: "." }), "workspace root");
  assert.equal(toolTarget({}), null);
  assert.equal(resultSummary("run_tests", { passed: false, exit_code: 1, output: "..." }), "Tests failed (exit 1)");
  assert.equal(resultSummary("run_tests", { passed: true, exit_code: 0 }), "All tests passed");
  assert.equal(resultSummary("run_health_check", { healthy: false, reason: "app is not running" }), "Unhealthy: app is not running");
  assert.equal(resultSummary("start_app", { ok: false, message: "app exited during startup" }), "app exited during startup");
  assert.equal(resultSummary("get_app_status", { state: "exited", exit_code: 1 }), "App exited (code 1)");
  assert.equal(resultSummary("read_logs", { log: "a\nb\n" }), "2 log lines");
  assert.equal(resultSummary("run_tests", { truncated: true, preview: '{"passed": false, "exit' }), "Reported a failure (output truncated)");
  assert.equal(resultSummary("read_text_file", "secret contents of file"), null, "file contents are not summarised inline");
  assert.equal(resultSummary("edit_file", "```diff\n--- a\n"), null, "diffs live in the raw output");
  assert.equal(resultSummary("write_file", "Successfully wrote to config.json"), "Successfully wrote to config.json");
  assert.equal(resultSummary("unknown", { anything: 1 }), null);
});

test("changesMade lists only successful file modifications", () => {
  seq = 0;
  const t = tl(
    ev("tool_started", { step: 1, tool: "read_text_file", args: { path: "a.py" } }),
    ev("tool_completed", { step: 1, tool: "read_text_file", result: "x" }),
    ev("tool_started", { step: 2, tool: "edit_file", args: { path: "a.py" } }),
    ev("tool_failed", { step: 2, tool: "edit_file", error: "no match" }),
    ev("tool_started", { step: 3, tool: "copy_file", args: { source: "b.bak", destination: "b" } }),
    ev("tool_completed", { step: 3, tool: "copy_file", result: "copied" }),
  );
  assert.deepEqual(changesMade(t).map((c) => [c.tool, c.target]), [["copy_file", "b.bak → b"]]);
});
