"use client";

import { useState } from "react";
import { ACTIVE_STATUSES, type CheckResult, type PlanStep, type Run } from "@/lib/api";
import StatusBadge from "./StatusBadge";

interface Props {
  run: Run | null;
  lost: boolean; // run vanished from the backend; final state unknown
  pollError: string | null;
  cancelling: boolean;
  cancelError: string | null;
  onCancel: () => void;
}

function fmtTime(ts: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }) : "—";
}

function fmtDuration(run: Run): string {
  if (!run.started_at) return "—";
  const end = run.finished_at ?? Date.now() / 1000;
  const s = Math.max(0, Math.round(end - run.started_at));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const PLAN_MARK: Record<PlanStep["status"], { mark: string; cls: string }> = {
  pending: { mark: "○", cls: "text-ink-faint" },
  in_progress: { mark: "◐", cls: "text-info" },
  done: { mark: "●", cls: "text-ok" },
  failed: { mark: "✕", cls: "text-bad" },
  skipped: { mark: "–", cls: "text-ink-faint" },
};

function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className={`mt-0.5 truncate text-sm text-ink ${mono ? "font-mono" : ""}`}>{children}</dd>
    </div>
  );
}

function Check({ name, check }: { name: string; check: CheckResult }) {
  return (
    <li className="flex items-center justify-between rounded-md border border-line bg-canvas px-3 py-2">
      <span className="text-sm text-ink-muted">{name}</span>
      <span className={`font-mono text-xs ${check.ok ? "text-ok" : "text-bad"}`}>{check.ok ? "PASS" : "FAIL"}</span>
    </li>
  );
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(id).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
      className="rounded px-1.5 py-0.5 text-xs text-ink-faint hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:outline-none"
      aria-label="Copy run ID"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

export default function RunSummary({ run, lost, pollError, cancelling, cancelError, onCancel }: Props) {
  if (!run) {
    return (
      <section aria-labelledby="summary-title" className="flex min-h-[320px] flex-col rounded-xl border border-dashed border-line bg-surface/50">
        <header className="px-5 py-4">
          <h2 id="summary-title" className="text-sm font-medium text-ink">Run summary</h2>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-10 text-center">
          <div aria-hidden className="mb-3 grid size-10 place-items-center rounded-lg border border-line font-mono text-lg text-ink-faint">
            ⌁
          </div>
          <p className="text-sm text-ink-muted">No run yet</p>
          <p className="mt-1 max-w-xs text-xs text-ink-faint">
            Start a recovery to see its status, diagnosis and verification result here.
          </p>
        </div>
      </section>
    );
  }

  const active = !lost && ACTIVE_STATUSES.includes(run.status);
  const r = run.result;
  const plan = run.plan?.length ? run.plan : (r?.plan ?? []);

  return (
    <section aria-labelledby="summary-title" className="rounded-xl border border-line bg-surface">
      <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 id="summary-title" className="text-sm font-medium text-ink">Run summary</h2>
          <div className="mt-1 flex items-center gap-1 font-mono text-xs text-ink-muted">
            <span className="truncate">{run.id}</span>
            <CopyId id={run.id} />
          </div>
        </div>
        <div aria-live="polite" aria-atomic="true">
          <StatusBadge status={lost ? "unknown" : run.status} />
        </div>
      </header>

      <div className="space-y-5 px-5 py-5">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          <Field label="Scenario" mono>{run.scenario}</Field>
          <Field label="Started" mono>{fmtTime(run.started_at ?? run.created_at)}</Field>
          <Field label="Duration" mono>{fmtDuration(run)}</Field>
          <Field label="Events" mono>{run.event_count}</Field>
        </dl>

        <div>
          <h3 className="text-xs text-ink-faint">Goal</h3>
          <p className="mt-1 text-sm leading-relaxed break-words text-ink-muted">{run.goal}</p>
        </div>

        {active && (
          <p className="flex items-center gap-2 text-sm text-info">
            <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-info/30 border-t-info" />
            {run.status === "queued" ? "Preparing isolated workspace…" : "Agent is investigating and repairing…"}
          </p>
        )}

        {plan.length > 0 && (
          <div>
            <h3 className="text-xs text-ink-faint">Recovery plan</h3>
            <ol className="mt-2 space-y-1.5">
              {plan.map((s, i) => {
                const m = PLAN_MARK[s.status] ?? PLAN_MARK.pending;
                return (
                  <li key={i} className="flex gap-2.5 text-sm">
                    <span aria-hidden className={`font-mono ${m.cls}`}>{m.mark}</span>
                    <span className="text-ink-muted">
                      {s.step}
                      <span className="sr-only"> ({s.status.replace("_", " ")})</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {r && (
          <div className="space-y-4 border-t border-line pt-5">
            <div
              className={`rounded-lg border px-3 py-2.5 text-sm ${
                r.status === "verified" ? "border-ok/30 bg-ok/5 text-ok" : "border-warn/30 bg-warn/5 text-warn"
              }`}
            >
              {r.status === "verified" ? "Recovery verified: " : "Not verified: "}
              <span className="text-ink-muted">{r.reason}</span>
            </div>

            {r.root_cause && (
              <div>
                <h3 className="text-xs text-ink-faint">Root cause</h3>
                <p className="mt-1 text-sm text-ink">{r.root_cause}</p>
              </div>
            )}
            {r.summary && (
              <div>
                <h3 className="text-xs text-ink-faint">Actions taken</h3>
                <p className="mt-1 text-sm text-ink-muted">{r.summary}</p>
              </div>
            )}
            {r.evidence.length > 0 && (
              <div>
                <h3 className="text-xs text-ink-faint">Evidence</h3>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-ink-muted marker:text-ink-faint">
                  {r.evidence.map((e, i) => (
                    <li key={i} className="break-words">{e}</li>
                  ))}
                </ul>
              </div>
            )}

            {r.verification && (
              <div>
                <h3 className="text-xs text-ink-faint">Independent verification</h3>
                <ul className="mt-2 grid gap-2 sm:grid-cols-3">
                  <Check name="Restart" check={r.verification.restart} />
                  <Check name="Health" check={r.verification.health} />
                  <Check name="Tests" check={r.verification.tests} />
                </ul>
              </div>
            )}

            <p className="font-mono text-xs text-ink-faint">
              {r.steps} agent steps · {r.tool_calls} tool calls
            </p>
          </div>
        )}

        {!r && run.error && (
          <div role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2.5 text-sm text-bad">
            {run.error}
          </div>
        )}
        {!r && run.status === "cancelled" && (
          <p className="text-sm text-ink-muted">This run was cancelled. The sandbox has been cleaned up.</p>
        )}

        {pollError && (
          <p role="status" className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
            {pollError}
          </p>
        )}
        {cancelError && (
          <p role="alert" className="text-xs text-bad">{cancelError}</p>
        )}
      </div>

      {active && (
        <footer className="flex justify-end border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            aria-busy={cancelling}
            className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink-muted hover:border-bad/50 hover:text-bad focus-visible:ring-2 focus-visible:ring-bad/30 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelling ? "Cancelling…" : "Cancel run"}
          </button>
        </footer>
      )}
    </section>
  );
}
