import type { CheckResult, Run } from "@/lib/api";
import { formatDetail, type TimelineState } from "@/lib/events";
import { changesMade } from "@/lib/tools";
import { IconAlert, IconCheck, IconChevron, IconEdit, IconShieldCheck, IconStop, IconX } from "../ui/icons";
import { SectionLabel } from "../ui/primitives";
import { fmtDuration } from "./RunHeader";

type Status = "verified" | "unverified" | "failed" | "cancelled" | "lost";

const HEAD: Record<Status, { Icon: typeof IconAlert; title: string; text: string; strip: string }> = {
  verified: { Icon: IconShieldCheck, title: "Service recovered and verified", text: "text-ok", strip: "bg-ok" },
  unverified: { Icon: IconAlert, title: "Recovery not verified", text: "text-warn", strip: "bg-warn" },
  failed: { Icon: IconAlert, title: "Recovery failed", text: "text-bad", strip: "bg-bad" },
  cancelled: { Icon: IconStop, title: "Run cancelled", text: "text-ink-muted", strip: "bg-ink-faint" },
  lost: { Icon: IconAlert, title: "Result unavailable", text: "text-bad", strip: "bg-bad" },
};

function CheckRow({ name, what, check }: { name: string; what: string; check: CheckResult }) {
  const detail = formatDetail(check.detail);
  return (
    <li className="py-2">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none">
          {check.ok ? (
            <IconCheck size={15} strokeWidth={2.5} className="shrink-0 text-ok" />
          ) : (
            <IconX size={15} strokeWidth={2.5} className="shrink-0 text-bad" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-ink">{name}</span>
            <span className="block text-xs text-ink-faint">{what}</span>
          </span>
          <span className={`text-xs font-medium ${check.ok ? "text-ok" : "text-bad"}`}>{check.ok ? "Pass" : "Fail"}</span>
          {detail && <IconChevron size={13} className="shrink-0 text-ink-faint transition-transform group-open:rotate-90" />}
        </summary>
        {detail && (
          <pre className="mt-2 max-h-56 overflow-auto rounded-md border border-line bg-sunken p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-muted [overflow-wrap:anywhere]">
            {detail}
          </pre>
        )}
      </details>
    </li>
  );
}

export default function OutcomePanel({ run, timeline, lost }: { run: Run; timeline: TimelineState; lost: boolean }) {
  const status: Status = lost ? "lost" : (run.status as Status);
  const h = HEAD[status] ?? HEAD.failed;
  const r = run.result;
  const changes = changesMade(timeline);
  const duration = run.started_at && run.finished_at ? fmtDuration(run.finished_at - run.started_at) : null;
  const reason =
    status === "verified"
      ? "Clean restart, health check and test suite all passed under backend control."
      : status === "cancelled"
        ? "Stopped before the agent finished. No diagnosis or verification was produced."
        : status === "lost"
          ? "The backend no longer has this run (it may have restarted)."
          : (r?.reason ?? run.error ?? "");
  const hasBody = !!r && status !== "cancelled";

  return (
    <section aria-labelledby="outcome-title" className="animate-enter overflow-hidden rounded-lg border border-line bg-surface">
      <div className="relative flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <span aria-hidden className={`absolute inset-y-0 left-0 w-0.5 ${h.strip}`} />
        <div className="flex min-w-0 items-start gap-3">
          <h.Icon size={18} className={`mt-0.5 shrink-0 ${h.text}`} />
          <div className="min-w-0">
            <h2 id="outcome-title" className={`text-[15px] font-semibold ${h.text}`}>
              {h.title}
            </h2>
            {reason && <p className="mt-0.5 text-[13px] break-words text-ink-muted">{reason}</p>}
          </div>
        </div>
        {r && (
          <dl className="flex shrink-0 gap-6 text-xs">
            {[
              ["Duration", duration ?? "—"],
              ["Steps", String(r.steps)],
              ["Tool calls", String(r.tool_calls)],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-ink-faint">{k}</dt>
                <dd className="mt-0.5 font-mono text-sm text-ink tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {hasBody && r && (
        <div className="grid border-t border-line lg:grid-cols-3 lg:divide-x lg:divide-line">
          <div className="space-y-4 p-4 sm:px-5">
            <div>
              <SectionLabel>Diagnosis</SectionLabel>
              <p className="mt-1.5 text-sm leading-relaxed break-words text-ink">{r.root_cause ?? "No root cause reported."}</p>
            </div>
            {r.summary && (
              <div>
                <SectionLabel>Agent summary</SectionLabel>
                <p className="mt-1.5 text-[13px] leading-relaxed break-words text-ink-muted">{r.summary}</p>
              </div>
            )}
          </div>

          <div className="space-y-4 border-t border-line p-4 sm:px-5 lg:border-t-0">
            <div>
              <SectionLabel>Changes applied</SectionLabel>
              {changes.length ? (
                <ul className="mt-1.5 space-y-1.5">
                  {changes.map((c) => (
                    <li key={c.seq} className="flex items-start gap-2 text-[13px]">
                      <IconEdit size={14} className="mt-0.5 shrink-0 text-accent-strong" />
                      <span className="min-w-0 break-words">
                        <span className="text-ink">{c.label}</span>
                        {c.target && <span className="ml-1.5 font-mono text-xs text-ink-muted">{c.target}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-[13px] text-ink-muted">No file changes recorded.</p>
              )}
            </div>
            {r.evidence.length > 0 && (
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-xs font-semibold tracking-wide text-ink-faint uppercase hover:text-ink-muted focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none">
                  <IconChevron size={12} className="transition-transform group-open:rotate-90" />
                  Agent evidence ({r.evidence.length})
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-ink-muted marker:text-ink-faint">
                  {r.evidence.map((e, i) => (
                    <li key={i} className="break-words">{e}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          <div className="border-t border-line p-4 sm:px-5 lg:border-t-0">
            <SectionLabel>Independent verification</SectionLabel>
            {r.verification ? (
              <ul className="mt-1 divide-y divide-line">
                <CheckRow name="Restart" what="Clean restart of the service" check={r.verification.restart} />
                <CheckRow name="Health" what="/health and /api/items return 200" check={r.verification.health} />
                <CheckRow name="Tests" what="Full unit test suite" check={r.verification.tests} />
              </ul>
            ) : (
              <p className="mt-1.5 text-[13px] text-ink-muted">The agent never reached verification.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
