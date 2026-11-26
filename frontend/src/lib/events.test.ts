import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_TIMELINE,
  applyEvent,
  applyEvents,
  formatDetail,
  parseEvent,
  reportsFailure,
  runningTools,
  type AgentEvent,
  type EventType,
} from "./events.ts";

let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}, s = seq++): AgentEvent {
  return { seq: s, type, ts: 1000 + s, data };
}

test("parseEvent accepts backend frames and rejects malformed ones", () => {
  const ok = parseEvent('{"seq":3,"type":"tool_started","ts":1795.5,"data":{"tool":"read_logs","step":2}}');
  assert.deepEqual(ok, { seq: 3, type: "tool_started", ts: 1795.5, data: { tool: "read_logs", step: 2 } });
  for (const bad of [
    "not json",
    "null",
    "[]",
    '{"seq":-1,"type":"run_started","ts":1,"data":{}}',
    '{"seq":1.5,"type":"run_started","ts":1,"data":{}}',
    '{"seq":"1","type":"run_started","ts":1,"data":{}}',
    '{"seq":1,"type":"run_hacked","ts":1,"data":{}}',
    '{"seq":1,"type":"run_started","data":{}}',
  ]) {
    assert.equal(parseEvent(bad), null, bad);
  }
  // non-object data is normalised, not trusted
  assert.deepEqual(parseEvent('{"seq":1,"type":"agent_status","ts":2,"data":[1,2]}')?.data, {});
});

test("duplicates and replayed overlap are ignored by seq", () => {
  seq = 0;
  const a = ev("run_started", { tools: ["read_logs"], max_steps: 20 });
  const b = ev("agent_status", { step: 1, text: "Checking logs." });
  const c = ev("tool_started", { step: 1, tool: "read_logs", args: { lines: 40 } });
  let s = applyEvents(EMPTY_TIMELINE, [a, b]);
  s = applyEvents(s, [a, b, c]); // reconnect replayed from the beginning
  s = applyEvent(s, c); // and a duplicate frame
  assert.equal(s.items.length, 3);
  assert.equal(s.eventCount, 3);
  assert.equal(s.lastSeq, 2);
  assert.equal(s.gaps, 0);
  assert.equal(applyEvent(s, b), s, "duplicate returns identical state (no re-render)");
});

test("tool_started/completed/failed pair into one row per invocation", () => {
  seq = 0;
  let s = applyEvents(EMPTY_TIMELINE, [
    ev("tool_started", { step: 1, tool: "start_app", args: {} }),
    ev("tool_started", { step: 1, tool: "read_logs", args: { lines: 30 } }),
  ]);
  assert.deepEqual(runningTools(s), ["start_app", "read_logs"]);
  s = applyEvents(s, [
    ev("tool_completed", { step: 1, tool: "read_logs", duration_s: 0.03, result: { log: "KeyError" } }),
    ev("tool_failed", { step: 1, tool: "start_app", duration_s: 1.2, error: "app exited" }),
  ]);
  assert.equal(s.items.length, 2);
  const [start, logs] = s.items as Extract<(typeof s.items)[number], { kind: "tool" }>[];
  assert.equal(start.state, "failed");
  assert.equal(start.error, "app exited");
  assert.equal(start.durationS, 1.2);
  assert.equal(logs.state, "ok");
  assert.deepEqual(logs.result, { log: "KeyError" });
  assert.deepEqual(runningTools(s), []);
});

test("same tool in different steps pairs with the right invocation", () => {
  seq = 0;
  const s = applyEvents(EMPTY_TIMELINE, [
    ev("tool_started", { step: 1, tool: "run_tests" }),
    ev("tool_started", { step: 2, tool: "run_tests" }),
    ev("tool_completed", { step: 2, tool: "run_tests", duration_s: 0.5, result: { passed: true } }),
  ]);
  const tools = s.items as Extract<(typeof s.items)[number], { kind: "tool" }>[];
  assert.equal(tools[0].state, "running");
  assert.equal(tools[1].state, "ok");
});

test("tool_failed without tool_started (rejected call) becomes its own failed row", () => {
  seq = 0;
  const s = applyEvent(EMPTY_TIMELINE, ev("tool_failed", { step: 3, tool: "update_plan", args: {}, error: "steps must be a non-empty list" }));
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind, "tool");
  assert.equal((s.items[0] as { state: string }).state, "failed");
});

test("plan revisions keep history and expose the latest plan", () => {
  seq = 0;
  const s = applyEvents(EMPTY_TIMELINE, [
    ev("plan_updated", { step: 1, plan: [{ step: "Inspect", status: "in_progress" }] }),
    ev("plan_updated", { step: 4, plan: [{ step: "Inspect", status: "done" }, { step: "Fix", status: "bogus" }, { nope: 1 }] }),
  ]);
  assert.equal(s.planRevisions, 2);
  assert.deepEqual(s.plan, [
    { step: "Inspect", status: "done" },
    { step: "Fix", status: "pending" }, // unknown status normalised, malformed step dropped
  ]);
  assert.equal(s.items.filter((i) => i.kind === "plan").length, 2);
});

test("verification started/completed pair per attempt with check results", () => {
  seq = 0;
  const s = applyEvents(EMPTY_TIMELINE, [
    ev("verification_started", { step: 5, attempt: 1 }),
    ev("verification_completed", { step: 5, attempt: 1, passed: false, restart: false, health: false, tests: false }),
    ev("verification_started", { step: 9, attempt: 2 }),
    ev("verification_completed", { step: 9, attempt: 2, passed: true, restart: true, health: true, tests: true }),
  ]);
  const v = s.items.filter((i) => i.kind === "verification") as Extract<(typeof s.items)[number], { kind: "verification" }>[];
  assert.equal(v.length, 2);
  assert.equal(v[0].state, "failed");
  assert.deepEqual(v[1].checks, { restart: true, health: true, tests: true });
  assert.equal(v[1].state, "passed");
});

test("terminal events: completed, failed (both shapes) and cancelled", () => {
  seq = 0;
  const done = applyEvent(EMPTY_TIMELINE, ev("run_completed", { status: "verified", reason: "independent verification passed" }));
  assert.equal(done.terminal?.type, "run_completed");
  const t = done.items[0] as { status: string; reason: string };
  assert.equal(t.status, "verified");

  seq = 0;
  const setup = applyEvent(EMPTY_TIMELINE, ev("run_failed", { status: "failed", reason: "MCPBridgeError: ..." }));
  assert.equal((setup.items[0] as { status: string }).status, "failed");

  seq = 0;
  const unverified = applyEvent(EMPTY_TIMELINE, ev("run_failed", { status: "unverified", reason: "verification failed 3 times", steps: 9 }));
  assert.equal((unverified.items[0] as { status: string }).status, "unverified");

  seq = 0;
  const cancelled = applyEvents(EMPTY_TIMELINE, [
    ev("tool_started", { step: 1, tool: "run_tests" }),
    ev("verification_started", { step: 1, attempt: 1 }),
    ev("run_cancelled", { reason: "cancelled by user" }),
  ]);
  const [tool, verif, term] = cancelled.items as { state?: string; interrupted?: boolean; status?: string }[];
  assert.equal(tool.state, "failed");
  assert.equal(tool.interrupted, true);
  assert.equal(verif.interrupted, true);
  assert.equal(term.status, "cancelled");
  assert.deepEqual(runningTools(cancelled), []);
});

test("events after the terminal event are ignored", () => {
  seq = 0;
  const s = applyEvents(EMPTY_TIMELINE, [ev("run_completed", { status: "verified" }), ev("agent_status", { text: "late" })]);
  assert.equal(s.items.length, 1);
  assert.equal(s.eventCount, 1);
});

test("seq gaps are counted, not hidden", () => {
  const s = applyEvents(EMPTY_TIMELINE, [ev("run_started", {}, 0), ev("agent_status", { text: "x" }, 5)]);
  assert.equal(s.gaps, 1);
  assert.equal(s.lastSeq, 5);
});

test("untrusted text is kept verbatim as data (rendered as text by React)", () => {
  seq = 0;
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const s = applyEvent(EMPTY_TIMELINE, ev("agent_status", { text: payload }));
  assert.equal((s.items[0] as { text: string }).text, payload);
  assert.ok(formatDetail({ log: payload }).includes("<script>"));
});

test("detail formatting is bounded", () => {
  assert.match(formatDetail({ truncated: true, preview: '{"log": "abc' }), /truncated by server/);
  const big = formatDetail("y".repeat(10000));
  assert.ok(big.length < 6100 && big.endsWith("(truncated)"));
  assert.equal(formatDetail(null), "");
});

test("completed tools whose result reports failure are detectable", () => {
  assert.equal(reportsFailure({ ok: false, message: "app exited during startup" }), true);
  assert.equal(reportsFailure({ healthy: false, checks: {} }), true);
  assert.equal(reportsFailure({ passed: false, exit_code: 1 }), true);
  assert.equal(reportsFailure({ ok: true }), false);
  assert.equal(reportsFailure({ state: "running" }), false);
  assert.equal(reportsFailure("text result"), false);
  assert.equal(reportsFailure([{ ok: false }]), false);
});

test("truncated results still expose a reported failure (real backend clip shape)", () => {
  // Exact prefix of a failing run_tests result clipped by the backend (code-bug scenario, 2403 chars).
  const clipped = { truncated: true, preview: '{"passed": false, "exit_code": 1, "output": "test_config_valid ... ERROR' };
  assert.equal(reportsFailure(clipped), true);
  assert.equal(reportsFailure({ truncated: true, preview: '{"healthy": false, "checks": {' }), true);
  assert.equal(reportsFailure({ truncated: true, preview: '{"passed": true, "exit_code": 0, "output": "' }), false);
  assert.equal(reportsFailure({ truncated: true, preview: '{"log": "... \\"ok\\": false ...' }), false, "only a leading status key counts");
  assert.equal(reportsFailure({ truncated: true }), false);
});

test("run_failed from setup (no agent result) still terminates cleanly", () => {
  seq = 0;
  const s = applyEvent(EMPTY_TIMELINE, ev("run_failed", { status: "failed", reason: "ValueError: model init failed" }));
  assert.ok(s.terminal);
  assert.equal(s.plan, null);
  assert.deepEqual(s.items.map((i) => i.kind), ["terminal"]);
});

test("terminal event without a status field falls back to null, not a fabricated status", () => {
  seq = 0;
  const s = applyEvent(EMPTY_TIMELINE, ev("run_failed", {}));
  assert.equal((s.items[0] as { status: string | null }).status, null);
  assert.equal((s.items[0] as { reason: string | null }).reason, null);
});
