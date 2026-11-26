"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { PlanStep } from "@/lib/api";
import { formatDetail, reportsFailure, runningTools, summarizeArgs, type TimelineItem, type TimelineState } from "@/lib/events";
import type { ConnectionState } from "@/lib/stream";

interface Props {
  timeline: TimelineState;
  connection: ConnectionState;
  lost: boolean;
  onRetry: () => void;
}

const NEAR_BOTTOM_PX = 48;

const PLAN_MARK: Record<PlanStep["status"], { mark: string; cls: string }> = {
  pending: { mark: "○", cls: "text-ink-faint" },
  in_progress: { mark: "◐", cls: "text-info" },
  done: { mark: "●", cls: "text-ok" },
  failed: { mark: "✕", cls: "text-bad" },
  skipped: { mark: "–", cls: "text-ink-faint" },
};

function fmtClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

function fmtOffset(ts: number, start: number): string {
  const s = Math.max(0, ts - start);
  return s < 60 ? `+${s.toFixed(1)}s` : `+${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

function ConnectionPill({ connection, lost }: { connection: ConnectionState; lost: boolean }) {
  const [dot, label] = lost
    ? ["bg-bad", "Disconnected"]
    : ({
        idle: ["bg-ink-faint", "Idle"],
        connecting: ["bg-ink-faint animate-pulse", "Connecting…"],
        open: ["bg-ok", "Live"],
        reconnecting: ["bg-warn animate-pulse", "Reconnecting…"],
        closed: ["bg-ink-faint", "Stream ended"],
        error: ["bg-bad", "Disconnected"],
      } as const)[connection];
  return (
    <span role="status" className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-muted">
      <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
      <span className="sr-only">Event stream: </span>
      {label}
    </span>
  );
}

function Details({ label, text, tone = "muted" }: { label: string; text: string; tone?: "muted" | "bad" }) {
  if (!text) return null;
  return (
    <details className="group mt-1.5">
      <summary className="cursor-pointer list-none text-xs text-ink-faint select-none hover:text-ink-muted focus-visible:text-ink focus-visible:outline-none">
        <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
        {label}
      </summary>
      <pre
        className={`mt-1.5 max-h-64 overflow-auto rounded-md border border-line bg-canvas p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] ${
          tone === "bad" ? "text-bad/90" : "text-ink-muted"
        }`}
      >
        {text}
      </pre>
    </details>
  );
}

function PlanList({ plan }: { plan: PlanStep[] }) {
  return (
    <ol className="mt-1.5 space-y-1">
      {plan.map((s, i) => {
        const m = PLAN_MARK[s.status] ?? PLAN_MARK.pending;
        return (
          <li key={i} className="flex gap-2 text-xs">
            <span aria-hidden className={`font-mono ${m.cls}`}>{m.mark}</span>
            <span className="text-ink-muted">
              {s.step}
              <span className="sr-only"> ({s.status.replace("_", " ")})</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Spinner({ cls = "border-info/30 border-t-info" }: { cls?: string }) {
  return <span aria-hidden className={`inline-block size-3 animate-spin rounded-full border-2 ${cls}`} />;
}

function Check({ name, ok, running }: { name: string; ok?: boolean; running: boolean }) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-2.5 py-1.5">
      <span className="text-xs text-ink-muted">{name}</span>
      {running ? (
        <Spinner cls="border-accent/30 border-t-accent" />
      ) : (
        <span className={`font-mono text-[11px] ${ok ? "text-ok" : "text-bad"}`}>{ok ? "PASS" : "FAIL"}</span>
      )}
    </li>
  );
}

function Row({ item, start, latestPlanSeq }: { item: TimelineItem; start: number; latestPlanSeq: number }) {
  const time = (
    <time
      dateTime={new Date(item.ts * 1000).toISOString()}
      title={fmtClock(item.ts)}
      className="w-14 shrink-0 pt-px text-right font-mono text-[11px] text-ink-faint tabular-nums"
    >
      {fmtOffset(item.ts, start)}
    </time>
  );

  switch (item.kind) {
    case "run_started":
      return (
        <li className="flex gap-3 py-2">
          {time}
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink">
              Run started
              <span className="text-ink-faint">
                {" "}· {item.tools.length} tools available{item.maxSteps ? ` · max ${item.maxSteps} steps` : ""}
              </span>
            </p>
            <Details label="Available tools" text={item.tools.join("  ")} />
          </div>
        </li>
      );

    case "plan":
      return (
        <li className="flex gap-3 py-2">
          {time}
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink">
              {item.revision === 1 ? "Plan created" : `Plan revised`}
              <span className="text-ink-faint"> · {item.plan.length} steps{item.revision > 1 ? ` · rev ${item.revision}` : ""}</span>
            </p>
            {item.seq === latestPlanSeq ? (
              <PlanList plan={item.plan} />
            ) : (
              <details className="group mt-1">
                <summary className="cursor-pointer list-none text-xs text-ink-faint hover:text-ink-muted">
                  <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
                  Previous plan
                </summary>
                <PlanList plan={item.plan} />
              </details>
            )}
          </div>
        </li>
      );

    case "status":
      return (
        <li className="flex gap-3 py-2">
          {time}
          <p className="min-w-0 flex-1 text-sm break-words text-ink-muted">
            <span className="mr-2 font-mono text-[11px] tracking-wide text-ink-faint uppercase">agent</span>
            {item.text}
          </p>
        </li>
      );

    case "tool": {
      const args = summarizeArgs(item.args);
      const negative = item.state === "ok" && reportsFailure(item.result);
      const color =
        item.state === "running" ? "text-info" : item.state === "failed" ? "text-bad" : negative ? "text-warn" : "text-ok";
      return (
        <li className="flex gap-3 py-2">
          {time}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={`font-mono text-sm ${color}`}>{item.tool}</span>
              {args && <span className="min-w-0 truncate font-mono text-xs text-ink-faint">{args}</span>}
              <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
                {item.state === "running" ? (
                  <>
                    <Spinner /> <span className="text-info">running</span>
                  </>
                ) : item.interrupted ? (
                  <span className="text-warn">interrupted</span>
                ) : (
                  <>
                    <span className={color}>
                      {item.state === "failed" ? "✕ failed" : negative ? "! reported failure" : "✓ ok"}
                    </span>
                    {item.durationS !== undefined && <span>{item.durationS.toFixed(2)}s</span>}
                  </>
                )}
              </span>
            </div>
            {item.state === "failed" && item.error && (
              <p className="mt-1 line-clamp-2 text-xs break-words text-bad/90">{item.error}</p>
            )}
            {item.args !== undefined && item.args !== null && Object.keys(item.args as object).length > 0 && (
              <Details label="Arguments" text={formatDetail(item.args)} />
            )}
            {item.state === "ok" && <Details label="Result" text={formatDetail(item.result)} />}
            {item.state === "failed" && item.error && item.error.length > 160 && (
              <Details label="Full error" text={item.error} tone="bad" />
            )}
          </div>
        </li>
      );
    }

    case "verification": {
      const running = item.state === "running" && !item.interrupted;
      return (
        <li className="py-2">
          <div
            className={`rounded-lg border px-3 py-2.5 ${
              running ? "border-accent/30 bg-accent/5" : item.state === "passed" ? "border-ok/30 bg-ok/5" : "border-warn/30 bg-warn/5"
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm text-ink">
                Independent verification
                {item.attempt !== null && <span className="text-ink-faint"> · attempt {item.attempt}</span>}
              </p>
              <span className="font-mono text-[11px] text-ink-faint" title={fmtClock(item.ts)}>
                {fmtOffset(item.ts, start)}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-ink-faint">Run by the backend, independent of the agent&apos;s claim.</p>
            {item.interrupted ? (
              <p className="mt-2 text-xs text-warn">Interrupted before completion.</p>
            ) : (
              <ul className="mt-2 grid grid-cols-3 gap-2">
                <Check name="Restart" ok={item.checks?.restart} running={running} />
                <Check name="Health" ok={item.checks?.health} running={running} />
                <Check name="Tests" ok={item.checks?.tests} running={running} />
              </ul>
            )}
            {!running && !item.interrupted && (
              <p className={`mt-2 text-xs ${item.state === "passed" ? "text-ok" : "text-warn"}`}>
                {item.state === "passed" ? "All checks passed." : "Verification failed."}
              </p>
            )}
          </div>
        </li>
      );
    }

    case "terminal": {
      const tone =
        item.type === "run_completed" ? "text-ok" : item.type === "run_cancelled" ? "text-ink-muted" : item.status === "unverified" ? "text-warn" : "text-bad";
      const title =
        item.type === "run_completed" ? "Run completed" : item.type === "run_cancelled" ? "Run cancelled" : "Run ended";
      return (
        <li className="flex gap-3 border-t border-line py-2.5">
          {time}
          <p className={`min-w-0 flex-1 text-sm break-words ${tone}`}>
            {title}
            {item.status && item.type !== "run_cancelled" && <span className="font-mono text-xs"> · {item.status}</span>}
            {item.reason && <span className="block text-xs text-ink-muted">{item.reason}</span>}
          </p>
        </li>
      );
    }
  }
}

export default function Timeline({ timeline, connection, lost, onRetry }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [seenCount, setSeenCount] = useState(0);
  const items = timeline.items;
  const start = items[0]?.ts ?? 0;
  const latestPlanSeq = [...items].reverse().find((i) => i.kind === "plan")?.seq ?? -1;
  const running = runningTools(timeline);
  const unseen = atBottom ? 0 : Math.max(0, items.length - seenCount);
  const showRetry = !lost && connection === "error" && !timeline.terminal;

  // Follow new events only while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [timeline.lastSeq, atBottom]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (near !== atBottom) {
      setAtBottom(near);
      if (!near) setSeenCount(items.length);
    }
  }

  function jumpToLatest() {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  return (
    <section aria-labelledby="timeline-title" className="rounded-xl border border-line bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-3.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 id="timeline-title" className="text-sm font-medium text-ink">Agent activity</h2>
          <span className="font-mono text-xs text-ink-faint">{timeline.eventCount} events</span>
        </div>
        <div className="flex items-center gap-3">
          {showRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-line-strong px-2 py-0.5 text-xs text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
            >
              Reconnect
            </button>
          )}
          <ConnectionPill connection={connection} lost={lost} />
        </div>
      </header>

      {running.length > 0 && (
        <p className="flex items-center gap-2 border-b border-line bg-info/5 px-5 py-2 font-mono text-xs text-info">
          <Spinner /> Executing: {running.join(", ")}
        </p>
      )}

      <div className="relative">
        <div
          ref={scroller}
          onScroll={onScroll}
          className="max-h-[70vh] overflow-y-auto px-4 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none focus-visible:ring-inset sm:max-h-[32rem] sm:px-5"
          tabIndex={0}
          aria-label="Agent activity log"
        >
          {items.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-faint">
              {connection === "error" || lost
                ? "Could not connect to the event stream."
                : "Waiting for the agent to start…"}
            </p>
          ) : (
            <ol role="log" aria-live="polite" aria-relevant="additions" className="divide-y divide-line/60 py-1">
              {items.map((it) => (
                <Row key={it.seq} item={it} start={start} latestPlanSeq={latestPlanSeq} />
              ))}
            </ol>
          )}
        </div>

        {unseen > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line-strong bg-raised px-3 py-1 font-mono text-xs text-ink shadow-lg shadow-black/40 hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
          >
            {unseen} new ↓
          </button>
        )}
      </div>

      {(connection === "reconnecting" || showRetry || lost) && (
        <p role="status" className="border-t border-line px-5 py-2 text-xs text-warn">
          {lost
            ? "The backend no longer has this run; live updates stopped."
            : showRetry
              ? "Live updates disconnected. The run summary keeps refreshing; reconnect to resume the timeline."
              : "Connection to the event stream dropped; resuming from the last received event…"}
        </p>
      )}
    </section>
  );
}
