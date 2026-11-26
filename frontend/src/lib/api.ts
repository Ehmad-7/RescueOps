// Typed client for the RescueOps FastAPI backend (see backend/app/main.py).

export type RunStatus = "queued" | "running" | "verified" | "unverified" | "failed" | "cancelled";

export const ACTIVE_STATUSES: RunStatus[] = ["queued", "running"];

export interface Health {
  status: string;
  version: string;
  gemini_configured: boolean;
  model: string;
}

export interface Scenario {
  id: string;
  description: string;
}

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "done" | "failed" | "skipped";
}

export interface CheckResult {
  ok: boolean;
  detail: unknown;
}

export interface Verification {
  passed: boolean;
  restart: CheckResult;
  health: CheckResult;
  tests: CheckResult;
}

export interface RunResult {
  status: "verified" | "unverified" | "failed";
  reason: string;
  steps: number;
  tool_calls: number;
  root_cause: string | null;
  summary: string | null;
  evidence: string[];
  verification: Verification | null;
  plan: PlanStep[];
}

export interface Run {
  id: string;
  goal: string;
  scenario: string;
  status: RunStatus;
  created_at: number; // epoch seconds
  started_at: number | null;
  finished_at: number | null;
  result: RunResult | null;
  error: string | null;
  event_count: number;
  plan?: PlanStep[];
  events_url?: string;
}

export const GOAL_MIN = 3;
export const GOAL_MAX = 500;

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

export class ApiError extends Error {
  readonly status: number | null; // HTTP status, or null for network/config errors

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const TIMEOUT_MS = 10_000;

/** FastAPI errors: {detail: string} or {detail: [{msg, loc}]} (validation). */
function detailMessage(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("detail" in body)) return null;
  const detail = (body as { detail: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const loc = Array.isArray(d?.loc) ? d.loc.filter((p: unknown) => p !== "body").join(".") : "";
        return loc ? `${loc}: ${d?.msg}` : String(d?.msg ?? "invalid request");
      })
      .join("; ");
  }
  return null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_URL) {
    throw new ApiError("NEXT_PUBLIC_API_URL is not configured for this deployment.", null);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "AbortError";
    throw new ApiError(
      timedOut ? "The backend did not respond in time." : "Cannot reach the RescueOps backend.",
      null,
    );
  } finally {
    clearTimeout(timer);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(detailMessage(body) ?? `Request failed (HTTP ${res.status}).`, res.status);
  }
  return body as T;
}

export const api = {
  health: () => request<Health>("/health"),
  scenarios: () => request<Scenario[]>("/scenarios"),
  createRun: (goal: string, scenario: string) =>
    request<Run>("/runs", { method: "POST", body: JSON.stringify({ goal, scenario }) }),
  getRun: (id: string) => request<Run>(`/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) =>
    request<{ id: string; status: string }>(`/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error.";
}
