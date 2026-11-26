"use client";

import { useEffect, useState } from "react";
import { ACTIVE_STATUSES, type Run } from "@/lib/api";
import type { TimelineState } from "@/lib/events";
import { derivePhase, deriveStages, type StageState } from "@/lib/phase";
import { scenarioCopy } from "../launch/scenarios";
import { IconCheck, IconCopy, IconPlus, IconStop, Spinner } from "../ui/icons";
import { Button, StatusBadge, toneText, type Tone } from "../ui/primitives";

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function fmtClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function CopyId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Run ID copied" : `Copy run ID ${value}`}
      onClick={() =>
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        )
      }
      className="inline-flex items-center gap-1.5 rounded font-mono text-ink-muted transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none"
    >
      {value}
      {copied ? <IconCheck size={12} className="text-ok" /> : <IconCopy size={12} />}
    </button>
  );
}

const PHASE_TONE: Record<string, Tone> = { active: "accent", ok: "ok", warn: "warn", bad: "bad", muted: "neutral" };

const STAGE_BAR: Record<StageState, string> = {
  done: "bg-ok",
  active: "bg-accent",
  failed: "bg-bad",
  skipped: "bg-line-strong",
  pending: "bg-line",
};
const STAGE_TEXT: Record<StageState, string> = {
  done: "text-ink-muted",
  active: "text-ink",
  failed: "text-bad",
  skipped: "text-ink-faint",
  pending: "text-ink-faint",
};

interface Props {
  run: Run;
  timeline: TimelineState;
  lost: boolean;
  eventCount: number;
  cancelling: boolean;
  onCancel: () => void;
  onNewRun: () => void;
}

export default function RunHeader({ run, timeline, lost, eventCount, cancelling, onCancel, onNewRun }: Props) {
  const active = !lost && ACTIVE_STATUSES.includes(run.status);
  const phase = derivePhase(run.status, lost, timeline);
  const stages = deriveStages(run.status, lost, timeline);
  const now = useNow(active);
  const started = run.started_at ?? run.created_at;
  const end = run.finished_at ?? (active ? now / 1000 : null);
  const sc = scenarioCopy(run.scenario);
  const tone = PHASE_TONE[phase.tone];

  return (
    <section aria-labelledby="incident-title" className="rounded-lg border border-line bg-surface">
      <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2" aria-live="polite" aria-atomic="true">
            <StatusBadge status={lost ? "unknown" : run.status} />
            {/* While running, the phase is the headline; once finished the badge already says it. */}
            <span className={`flex min-w-0 items-center gap-2 text-[13px] font-medium ${toneText(tone)} ${active ? "" : "sr-only"}`}>
              {active && <Spinner size={12} />}
              <span id="run-phase">{phase.label}</span>
            </span>
            <span className="min-w-0 text-[13px] break-words text-ink-faint">{phase.detail}</span>
          </div>
          <h1 id="incident-title" title={run.goal} className="text-base leading-snug font-semibold break-words text-ink sm:text-lg lg:line-clamp-3">
            {run.goal}
          </h1>
          <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <div className="flex items-center gap-1.5">
              <dt className="sr-only">Environment</dt>
              <sc.Icon size={13} className="text-ink-faint" />
              <dd className="text-ink-muted">{sc.title}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-ink-faint">Run</dt>
              <dd>
                <CopyId value={run.id} />
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-ink-faint">Started</dt>
              <dd className="font-mono text-ink-muted tabular-nums">{fmtClock(started)}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-ink-faint">{active ? "Elapsed" : "Duration"}</dt>
              <dd className="font-mono text-ink-muted tabular-nums">{end ? fmtDuration(end - started) : "—"}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-ink-faint">Events</dt>
              <dd className="font-mono text-ink-muted tabular-nums">{eventCount}</dd>
            </div>
          </dl>
        </div>

        <div className="flex shrink-0 gap-2">
          {active ? (
            <Button variant="danger" onClick={onCancel} disabled={cancelling} loading={cancelling} icon={<IconStop size={13} />}>
              {cancelling ? "Cancelling…" : "Cancel run"}
            </Button>
          ) : (
            <Button variant="primary" onClick={onNewRun} icon={<IconPlus size={14} />}>
              New recovery
            </Button>
          )}
        </div>
      </div>

      <ol aria-label="Recovery progress" className="grid grid-cols-4 border-t border-line">
        {stages.map((s) => (
          <li key={s.key} className="min-w-0 px-3 py-2.5 sm:px-5">
            <span aria-hidden className={`block h-0.5 rounded-full ${STAGE_BAR[s.state]} ${s.state === "active" ? "animate-pulse" : ""}`} />
            <span className={`mt-2 block truncate text-xs font-medium ${STAGE_TEXT[s.state]}`}>
              {s.label}
              <span className="sr-only"> ({s.state})</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
