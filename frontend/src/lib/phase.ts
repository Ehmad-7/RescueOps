// Live run phase and progress stages, derived ONLY from the authoritative run status and the
// real event timeline. Nothing here guesses what the agent is "thinking".

import type { RunStatus } from "./api";
import type { TimelineItem, TimelineState } from "./events.ts";
import { WRITE_TOOLS, toolLabel } from "./tools.ts";

export type Tone = "active" | "ok" | "warn" | "bad" | "muted";

export interface Phase {
  key: string;
  label: string;
  detail: string;
  tone: Tone;
}

type Tool = Extract<TimelineItem, { kind: "tool" }>;
type Verification = Extract<TimelineItem, { kind: "verification" }>;

export function derivePhase(status: RunStatus, lost: boolean, t: TimelineState): Phase {
  if (lost) return { key: "lost", label: "Run unavailable", detail: "The backend no longer has this run (it may have restarted).", tone: "bad" };
  switch (status) {
    case "verified":
      return { key: "verified", label: "Recovery verified", detail: "Independent verification passed.", tone: "ok" };
    case "unverified":
      return { key: "unverified", label: "Not verified", detail: "The agent finished, but independent verification did not pass.", tone: "warn" };
    case "failed":
      return { key: "failed", label: "Recovery failed", detail: "The run ended without a verified recovery.", tone: "bad" };
    case "cancelled":
      return { key: "cancelled", label: "Cancelled", detail: "The run was stopped and its sandbox cleaned up.", tone: "muted" };
  }
  if (t.terminal) return { key: "finalizing", label: "Finalizing", detail: "Collecting the final result…", tone: "active" };
  const items = t.items;
  if (status === "queued" || !items.some((i) => i.kind === "run_started")) {
    return { key: "init", label: "Initializing", detail: "Creating an isolated workspace and connecting MCP tools…", tone: "active" };
  }
  const verifying = items.find((i): i is Verification => i.kind === "verification" && i.state === "running");
  if (verifying) return { key: "verifying", label: "Verifying recovery", detail: "Backend is restarting the service, checking health and running tests.", tone: "active" };
  const running = items.find((i): i is Tool => i.kind === "tool" && i.state === "running");
  if (running) {
    return {
      key: WRITE_TOOLS.has(running.tool) ? "repairing" : "executing",
      label: WRITE_TOOLS.has(running.tool) ? "Applying repair" : "Executing tool",
      detail: `${toolLabel(running.tool)} (${running.tool})`,
      tone: "active",
    };
  }
  const last = items[items.length - 1];
  switch (last?.kind) {
    case "plan":
      return last.revision > 1
        ? { key: "replanning", label: "Replanning", detail: `Plan revised (revision ${last.revision}).`, tone: "active" }
        : { key: "planning", label: "Plan ready", detail: "The agent has planned its investigation.", tone: "active" };
    case "verification":
      return last.state === "failed"
        ? { key: "verify-failed", label: "Verification failed", detail: "Results were returned to the agent; it is continuing.", tone: "warn" }
        : { key: "analyzing", label: "Analyzing results", detail: "Waiting for the agent's next decision.", tone: "active" };
    case "tool":
      return { key: "analyzing", label: "Analyzing results", detail: `Last action: ${toolLabel(last.tool)}.`, tone: "active" };
    default:
      return { key: "investigating", label: "Investigating", detail: "The agent is deciding its first actions.", tone: "active" };
  }
}

export type StageState = "pending" | "active" | "done" | "failed" | "skipped";

export interface Stage {
  key: "diagnose" | "repair" | "verify" | "result";
  label: string;
  state: StageState;
}

/** Four-stage progress: Diagnose → Repair → Verify → Result, from real events only. */
export function deriveStages(status: RunStatus, lost: boolean, t: TimelineState): Stage[] {
  const items = t.items;
  const started = items.some((i) => i.kind === "run_started");
  const tools = items.filter((i): i is Tool => i.kind === "tool");
  const wrote = tools.some((i) => i.state === "ok" && WRITE_TOOLS.has(i.tool));
  const writing = tools.some((i) => i.state === "running" && WRITE_TOOLS.has(i.tool));
  const verifs = items.filter((i): i is Verification => i.kind === "verification");
  const lastV = verifs[verifs.length - 1];
  const terminal = ["verified", "unverified", "failed", "cancelled"].includes(status) || lost;

  const diagnose: StageState = !started ? (terminal ? "skipped" : "pending") : wrote || writing || lastV ? "done" : terminal ? "done" : "active";
  const repair: StageState = writing ? "active" : wrote ? "done" : lastV || terminal ? "skipped" : "pending";
  const verify: StageState = !lastV
    ? terminal
      ? "skipped"
      : "pending"
    : lastV.state === "running" && !lastV.interrupted
      ? "active"
      : lastV.state === "passed"
        ? "done"
        : terminal
          ? "failed"
          : "active";
  const result: StageState =
    status === "verified" ? "done" : status === "unverified" || status === "failed" || lost ? "failed" : status === "cancelled" ? "skipped" : "pending";

  return [
    { key: "diagnose", label: "Diagnose", state: diagnose },
    { key: "repair", label: "Repair", state: repair },
    { key: "verify", label: "Verify", state: verify },
    { key: "result", label: "Result", state: result },
  ];
}
