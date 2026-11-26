import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, EventType } from "./events.ts";
import { RunEventStream, type ConnectionState, type EventSourceLike } from "./stream.ts";

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  send(e: AgentEvent) {
    this.emit(e.type, JSON.stringify(e));
  }
  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

function harness(opts: { maxRetries?: number } = {}) {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const events: AgentEvent[] = [];
  const states: ConnectionState[] = [];
  const stream = new RunEventStream({
    url: (after) => `/runs/r1/events${after >= 0 ? `?after=${after}` : ""}`,
    createSource: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    onEvent: (e) => events.push(e),
    onState: (s) => states.push(s),
    maxRetries: opts.maxRetries ?? 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
  });
  const last = () => sources[sources.length - 1];
  const fire = () => {
    const t = timers.find((x) => !x.cleared && x.fn);
    assert.ok(t, "expected a pending timer");
    t.cleared = true;
    t.fn();
  };
  return { stream, sources, timers, events, states, last, fire };
}

const e = (seq: number, type: EventType = "agent_status", data: Record<string, unknown> = {}): AgentEvent => ({
  seq,
  type,
  ts: 100 + seq,
  data,
});

test("connects without ?after, opens, and delivers events in order", () => {
  const h = harness();
  h.stream.start();
  assert.equal(h.last().url, "/runs/r1/events");
  h.last().open();
  h.last().send(e(0, "run_started"));
  h.last().send(e(1));
  assert.deepEqual(h.events.map((x) => x.seq), [0, 1]);
  assert.deepEqual(h.states, ["connecting", "open"]);
  assert.equal(h.stream.lastSeq, 1);
});

test("listens to every backend event type and ignores malformed / unknown frames", () => {
  const h = harness();
  h.stream.start();
  const types = [...h.last().listeners.keys()];
  assert.ok(types.includes("run_cancelled") && types.includes("verification_completed"));
  h.last().emit("agent_status", "{not json");
  h.last().emit("agent_status", JSON.stringify({ seq: 0, type: "nope", ts: 1, data: {} }));
  assert.equal(h.events.length, 0);
});

test("native reconnect (CONNECTING) shows reconnecting and drops replayed duplicates", () => {
  const h = harness();
  h.stream.start();
  h.last().open();
  h.last().send(e(0));
  h.last().send(e(1));
  h.last().fail(0); // browser retries by itself with Last-Event-ID
  assert.equal(h.stream.state, "reconnecting");
  assert.equal(h.sources.length, 1, "no manual reconnect while native retry is in progress");
  h.last().open();
  h.last().send(e(1)); // overlap
  h.last().send(e(2));
  assert.deepEqual(h.events.map((x) => x.seq), [0, 1, 2]);
  assert.equal(h.stream.state, "open");
});

test("EventSource giving up (CLOSED) triggers manual reconnect with ?after and backoff", () => {
  const h = harness();
  h.stream.start();
  h.last().open();
  h.last().send(e(0));
  h.last().send(e(1));
  h.last().fail(2);
  assert.equal(h.sources[0].closed, true);
  assert.equal(h.stream.state, "reconnecting");
  assert.equal(h.timers[0].ms, 100);
  h.fire();
  assert.equal(h.last().url, "/runs/r1/events?after=1");
  h.last().fail(2);
  assert.equal(h.timers[1].ms, 200, "exponential backoff");
  h.fire();
  h.last().open(); // success resets the retry budget
  h.last().send(e(2));
  h.last().fail(2);
  assert.equal(h.timers[2].ms, 100);
  assert.deepEqual(h.events.map((x) => x.seq), [0, 1, 2]);
});

test("retry budget exhausted → error state; manual retry() resumes from lastSeq", () => {
  const h = harness({ maxRetries: 2 });
  h.stream.start();
  h.last().open();
  h.last().send(e(0));
  h.last().fail(2);
  h.fire();
  h.last().fail(2);
  h.fire();
  h.last().fail(2);
  assert.equal(h.stream.state, "error");
  assert.equal(h.timers.filter((t) => !t.cleared).length, 0, "no more automatic attempts");
  h.stream.retry();
  assert.equal(h.last().url, "/runs/r1/events?after=0");
  assert.equal(h.stream.state, "connecting");
});

test("terminal event closes the stream for good (no reconnect loop)", () => {
  const h = harness();
  h.stream.start();
  h.last().open();
  h.last().send(e(0));
  h.last().send(e(1, "run_completed", { status: "verified" }));
  assert.equal(h.last().closed, true);
  assert.equal(h.stream.state, "closed");
  assert.equal(h.stream.terminal, true);
  h.sources[0].onerror?.(new Event("error")); // handler was detached, but be sure
  h.stream.retry(); // no-op after terminal
  assert.equal(h.sources.length, 1);
  assert.equal(h.timers.length, 0);
});

test("stop() closes and cancels any pending reconnect", () => {
  const h = harness();
  h.stream.start();
  h.last().fail(2);
  assert.equal(h.timers.length, 1);
  h.stream.stop();
  assert.equal(h.timers[0].cleared, true);
  assert.equal(h.sources.length, 1);
});

test("stale source callbacks after a reconnect are ignored", () => {
  const h = harness();
  h.stream.start();
  const first = h.last();
  first.open();
  first.send(e(0));
  const onmsg = first.listeners.get("agent_status")![0];
  first.fail(2);
  h.fire();
  onmsg({ data: JSON.stringify(e(5)) }); // late frame from the old connection
  assert.deepEqual(h.events.map((x) => x.seq), [0]);
});

test("native retries that end in CLOSED fall back to manual ?after reconnect", () => {
  const h = harness();
  h.stream.start();
  h.last().open();
  h.last().send(e(0));
  h.last().send(e(1));
  h.last().send(e(2));
  h.last().fail(0); // native retry in progress
  h.last().fail(0);
  assert.equal(h.sources.length, 1);
  h.last().fail(2); // browser gives up (e.g. HTTP 502)
  h.fire();
  assert.equal(h.last().url, "/runs/r1/events?after=2");
});

test("malformed or unknown frames never advance lastSeq (so ?after cannot skip events)", () => {
  const h = harness();
  h.stream.start();
  h.last().open();
  h.last().send(e(0));
  h.last().emit("agent_status", '{"seq": 7, "type": "agent_status"}'); // missing ts -> rejected
  assert.equal(h.stream.lastSeq, 0);
  h.last().fail(2);
  h.fire();
  assert.equal(h.last().url, "/runs/r1/events?after=0");
});

test("frames delivered after stop() are ignored and the terminal callback fires once", () => {
  const h = harness();
  h.stream.start();
  const src = h.last();
  src.open();
  const onmsg = src.listeners.get("run_completed")![0];
  src.send(e(0, "run_completed", { status: "verified" }));
  onmsg({ data: JSON.stringify(e(0, "run_completed")) }); // duplicate terminal frame
  onmsg({ data: JSON.stringify(e(1, "run_completed")) }); // late frame on a closed source
  assert.equal(h.events.filter((x) => x.type === "run_completed").length, 1);
  h.stream.stop();
  onmsg({ data: JSON.stringify(e(2)) });
  assert.equal(h.events.length, 1);
});
