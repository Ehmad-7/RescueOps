import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRun, type Run } from "./api.ts";

const run = (id: string, status: Run["status"]): Run => ({
  id,
  goal: "g",
  scenario: "code-bug",
  status,
  created_at: 1,
  started_at: 1,
  finished_at: null,
  result: null,
  error: null,
  event_count: 0,
});

test("mergeRun applies newer state for the current run", () => {
  const next = run("a", "verified");
  assert.equal(mergeRun(run("a", "running"), next), next);
});

test("late responses never resurrect a run the user already left", () => {
  // e.g. refreshNow()/cancel() resolving after "Start new recovery" cleared the run
  assert.equal(mergeRun(null, run("a", "verified")), null);
  const current = run("b", "running");
  assert.equal(mergeRun(current, run("a", "verified")), current);
});

test("a terminal run never goes back to active from a stale poll", () => {
  const done = run("a", "cancelled");
  assert.equal(mergeRun(done, run("a", "running")), done);
});
