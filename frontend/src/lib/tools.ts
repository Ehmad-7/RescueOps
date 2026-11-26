// Human-readable presentation of the backend's MCP tools (backend/app/mcp_bridge.py + ops/server.py).
// Summaries are derived only from fields present in the actual tool result.

import { reportsFailure, type TimelineItem, type TimelineState } from "./events.ts";

export type ToolKind = "inspect" | "read" | "write" | "app" | "check";

const META: Record<string, { label: string; kind: ToolKind }> = {
  read_text_file: { label: "Read file", kind: "read" },
  read_multiple_files: { label: "Read files", kind: "read" },
  list_directory: { label: "Listed directory", kind: "read" },
  directory_tree: { label: "Explored project tree", kind: "read" },
  search_files: { label: "Searched files", kind: "read" },
  get_file_info: { label: "Inspected file", kind: "read" },
  write_file: { label: "Wrote file", kind: "write" },
  edit_file: { label: "Edited file", kind: "write" },
  create_directory: { label: "Created directory", kind: "write" },
  copy_file: { label: "Copied file", kind: "write" },
  get_app_status: { label: "Checked app status", kind: "inspect" },
  read_logs: { label: "Read application logs", kind: "inspect" },
  start_app: { label: "Started the app", kind: "app" },
  stop_app: { label: "Stopped the app", kind: "app" },
  restart_app: { label: "Restarted the app", kind: "app" },
  run_health_check: { label: "Ran health check", kind: "check" },
  run_tests: { label: "Ran test suite", kind: "check" },
  update_plan: { label: "Plan update rejected", kind: "inspect" },
};

export const WRITE_TOOLS = new Set(Object.keys(META).filter((k) => META[k].kind === "write"));

export function toolLabel(tool: string): string {
  return META[tool]?.label ?? tool;
}

export function toolKind(tool: string): ToolKind {
  return META[tool]?.kind ?? "inspect";
}

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The file/path a tool acted on, from its arguments. */
export function toolTarget(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (s(a.source) && s(a.destination)) return `${a.source} → ${a.destination}`;
  if (Array.isArray(a.paths)) return a.paths.filter((p) => typeof p === "string").join(", ") || null;
  const path = s(a.path) === "." || s(a.path) === "./" ? "workspace root" : s(a.path);
  const pattern = s(a.pattern);
  if (path && pattern) return `${pattern} in ${path}`;
  return path;
}

const clip = (t: string, n = 90) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Short outcome line for a finished tool, or null when nothing meaningful can be said. */
export function resultSummary(tool: string, result: unknown): string | null {
  if (result && typeof result === "object" && (result as Record<string, unknown>).truncated === true) {
    return reportsFailure(result) ? "Reported a failure (output truncated)" : null;
  }
  if (typeof result === "string") {
    const first = result.split("\n").find((l) => l.trim());
    // File contents, trees and diffs have no meaningful one-line summary (they're in the raw output).
    const noSummary = ["read_text_file", "read_multiple_files", "directory_tree", "edit_file"];
    return first && !noSummary.includes(tool) && !first.trim().startsWith("```") ? clip(first.trim()) : null;
  }
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  switch (tool) {
    case "start_app":
    case "stop_app":
    case "restart_app":
      return s(r.message) ? clip(String(r.message)) : null;
    case "get_app_status": {
      const st = s(r.state);
      if (!st) return null;
      return st === "exited" && typeof r.exit_code === "number" ? `App exited (code ${r.exit_code})` : `App ${st.replace("_", " ")}`;
    }
    case "run_health_check":
      if (r.healthy === true) return "Service healthy";
      if (r.healthy === false) return s(r.reason) ? `Unhealthy: ${clip(String(r.reason), 60)}` : "Service unhealthy";
      return null;
    case "run_tests":
      if (r.passed === true) return "All tests passed";
      if (r.passed === false) return typeof r.exit_code === "number" ? `Tests failed (exit ${r.exit_code})` : "Tests failed";
      return null;
    case "read_logs": {
      const log = typeof r.log === "string" ? r.log : "";
      if (!log.trim()) return s(r.message) ?? "No log output";
      const n = log.split("\n").filter((l) => l.trim()).length;
      return `${n} log line${n === 1 ? "" : "s"}`;
    }
    default:
      return null;
  }
}

export interface Change {
  seq: number;
  tool: string;
  label: string;
  target: string | null;
}

/** Successful file modifications the agent actually performed (from tool events). */
export function changesMade(timeline: TimelineState): Change[] {
  return timeline.items
    .filter((i): i is Extract<TimelineItem, { kind: "tool" }> => i.kind === "tool" && i.state === "ok" && WRITE_TOOLS.has(i.tool))
    .map((i) => ({ seq: i.seq, tool: i.tool, label: toolLabel(i.tool), target: toolTarget(i.args) }));
}
