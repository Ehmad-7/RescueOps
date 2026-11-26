// Agent lifecycle events from GET /runs/{id}/events (backend/app/events.py + agent.py).
// SSE frame: `id: <seq>` / `event: <type>` / `data: {"seq","type","ts","data":{...}}`.
// Everything here is untrusted text from the backend/agent; it is only ever rendered as text.

import type { PlanStep } from "./api";

export const EVENT_TYPES = [
  "run_started",
  "plan_updated",
  "agent_status",
  "tool_started",
  "tool_completed",
  "tool_failed",
  "verification_started",
  "verification_completed",
  "run_completed",
  "run_failed",
  "run_cancelled",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const TERMINAL_TYPES: ReadonlySet<EventType> = new Set(["run_completed", "run_failed", "run_cancelled"]);

export interface AgentEvent {
  seq: number;
  type: EventType;
  ts: number; // epoch seconds
  data: Record<string, unknown>;
}

const KNOWN = new Set<string>(EVENT_TYPES);

/** Parse an SSE `data:` payload. Returns null for anything malformed or of an unknown type. */
export function parseEvent(raw: string): AgentEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Number.isInteger(o.seq) || (o.seq as number) < 0) return null;
  if (typeof o.type !== "string" || !KNOWN.has(o.type)) return null;
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return null;
  const data = o.data && typeof o.data === "object" && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : {};
  return { seq: o.seq as number, type: o.type as EventType, ts: o.ts, data };
}

// ------------------------------------------------------------------ timeline model

export interface Checks {
  restart: boolean;
  health: boolean;
  tests: boolean;
}

export type TimelineItem =
  | { kind: "run_started"; seq: number; ts: number; tools: string[]; maxSteps: number | null }
  | { kind: "plan"; seq: number; ts: number; plan: PlanStep[]; revision: number }
  | { kind: "status"; seq: number; ts: number; text: string }
  | {
      kind: "tool";
      seq: number;
      ts: number;
      step: number | null;
      tool: string;
      args: unknown;
      state: "running" | "ok" | "failed";
      endTs?: number;
      durationS?: number;
      result?: unknown;
      error?: string;
      interrupted?: boolean; // run ended before this tool reported back
    }
  | {
      kind: "verification";
      seq: number;
      ts: number;
      attempt: number | null;
      state: "running" | "passed" | "failed";
      checks?: Checks;
      interrupted?: boolean;
    }
  | { kind: "terminal"; seq: number; ts: number; type: EventType; status: string | null; reason: string | null };

export interface TimelineState {
  lastSeq: number; // highest seq applied; events with seq <= lastSeq are duplicates
  items: TimelineItem[];
  plan: PlanStep[] | null; // latest plan from plan_updated
  planRevisions: number;
  terminal: AgentEvent | null;
  eventCount: number;
  gaps: number; // seq jumps (should not happen: the server replays contiguously)
}

export const EMPTY_TIMELINE: TimelineState = {
  lastSeq: -1,
  items: [],
  plan: null,
  planRevisions: 0,
  terminal: null,
  eventCount: 0,
  gaps: 0,
};

const PLAN_STATUSES = new Set(["pending", "in_progress", "done", "failed", "skipped"]);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parsePlan(v: unknown): PlanStep[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is { step: string; status: string } => !!s && typeof s === "object" && typeof s.step === "string")
    .map((s) => ({ step: s.step, status: (PLAN_STATUSES.has(s.status) ? s.status : "pending") as PlanStep["status"] }));
}

/** Apply one event. Pure; duplicates (seq <= lastSeq) and events after the terminal one are ignored. */
export function applyEvent(state: TimelineState, ev: AgentEvent): TimelineState {
  if (ev.seq <= state.lastSeq || state.terminal) return state;
  const d = ev.data;
  const base = {
    ...state,
    lastSeq: ev.seq,
    eventCount: state.eventCount + 1,
    gaps: state.gaps + (ev.seq > state.lastSeq + 1 ? 1 : 0),
  };
  const push = (item: TimelineItem): TimelineState => ({ ...base, items: [...state.items, item] });

  switch (ev.type) {
    case "run_started":
      return push({
        kind: "run_started",
        seq: ev.seq,
        ts: ev.ts,
        tools: Array.isArray(d.tools) ? d.tools.filter((t): t is string => typeof t === "string") : [],
        maxSteps: num(d.max_steps),
      });
    case "plan_updated": {
      const plan = parsePlan(d.plan);
      const revision = state.planRevisions + 1;
      return { ...push({ kind: "plan", seq: ev.seq, ts: ev.ts, plan, revision }), plan, planRevisions: revision };
    }
    case "agent_status":
      return push({ kind: "status", seq: ev.seq, ts: ev.ts, text: str(d.text) ?? "" });
    case "tool_started":
      return push({
        kind: "tool",
        seq: ev.seq,
        ts: ev.ts,
        step: num(d.step),
        tool: str(d.tool) ?? "unknown",
        args: d.args,
        state: "running",
      });
    case "tool_completed":
    case "tool_failed": {
      const tool = str(d.tool) ?? "unknown";
      const step = num(d.step);
      const ok = ev.type === "tool_completed";
      const patch = {
        state: (ok ? "ok" : "failed") as "ok" | "failed",
        endTs: ev.ts,
        durationS: num(d.duration_s) ?? undefined,
        result: ok ? d.result : undefined,
        error: ok ? undefined : (str(d.error) ?? "tool failed"),
      };
      // Pair with the oldest still-running invocation of the same tool in the same step.
      const idx = state.items.findIndex(
        (it) => it.kind === "tool" && it.state === "running" && it.tool === tool && it.step === step,
      );
      if (idx >= 0) {
        const items = state.items.slice();
        items[idx] = { ...(items[idx] as Extract<TimelineItem, { kind: "tool" }>), ...patch };
        return { ...base, items };
      }
      // Rejected before execution (e.g. malformed arguments): no tool_started was emitted.
      return push({ kind: "tool", seq: ev.seq, ts: ev.ts, step, tool, args: d.args, ...patch });
    }
    case "verification_started":
      return push({ kind: "verification", seq: ev.seq, ts: ev.ts, attempt: num(d.attempt), state: "running" });
    case "verification_completed": {
      const attempt = num(d.attempt);
      const passed = d.passed === true;
      const checks: Checks = { restart: d.restart === true, health: d.health === true, tests: d.tests === true };
      const patch = { state: (passed ? "passed" : "failed") as "passed" | "failed", checks };
      const idx = state.items.findIndex(
        (it) => it.kind === "verification" && it.state === "running" && it.attempt === attempt,
      );
      if (idx >= 0) {
        const items = state.items.slice();
        items[idx] = { ...(items[idx] as Extract<TimelineItem, { kind: "verification" }>), ...patch };
        return { ...base, items };
      }
      return push({ kind: "verification", seq: ev.seq, ts: ev.ts, attempt, ...patch });
    }
    case "run_completed":
    case "run_failed":
    case "run_cancelled": {
      const next = push({
        kind: "terminal",
        seq: ev.seq,
        ts: ev.ts,
        type: ev.type,
        status: ev.type === "run_cancelled" ? "cancelled" : str(d.status),
        reason: str(d.reason),
      });
      // Anything still running never reported back (e.g. cancelled mid-tool).
      const items = next.items.map((it): TimelineItem =>
        (it.kind === "tool" || it.kind === "verification") && it.state === "running"
          ? { ...it, state: "failed", interrupted: true }
          : it,
      );
      return { ...next, items, terminal: ev };
    }
  }
}

export function applyEvents(state: TimelineState, events: AgentEvent[]): TimelineState {
  return events.reduce(applyEvent, state);
}

export function runningTools(state: TimelineState): string[] {
  return state.items.filter((i) => i.kind === "tool" && i.state === "running").map((i) => (i as { tool: string }).tool);
}

// ------------------------------------------------------------------ display helpers

/**
 * A tool can complete (the MCP call succeeded) while its result reports a failure, e.g.
 * start_app -> {ok: false, message: "app exited during startup"} or run_tests -> {passed: false}.
 */
export function reportsFailure(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const r = result as Record<string, unknown>;
  if (r.truncated === true && typeof r.preview === "string") {
    // The backend clips large results to {truncated, preview: <JSON text prefix>}. Ops tools put
    // their status key first (e.g. a failing run_tests is `{"passed": false, "exit_code": ...`).
    return TRUNCATED_FAILURE.test(r.preview);
  }
  return r.ok === false || r.healthy === false || r.passed === false;
}

const TRUNCATED_FAILURE = /^\{\s*"(?:ok|healthy|passed)"\s*:\s*false\b/;

const MAX_DETAIL = 6000;

/** Pretty text for an expandable details section. Server-truncated payloads show their preview. */
export function formatDetail(v: unknown): string {
  if (v === undefined || v === null) return "";
  let text: string;
  if (typeof v === "string") text = v;
  else if (typeof v === "object" && (v as Record<string, unknown>).truncated === true) {
    text = `${String((v as Record<string, unknown>).preview ?? "")}\n… (truncated by server)`;
  } else {
    text = JSON.stringify(v, null, 2);
  }
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n… (truncated)` : text;
}
