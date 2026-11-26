// One row of the execution log. Rows are dense, aligned and scannable; tool rows expand to show the
// real input and output. Every row is derived from an actual backend event.
import type { ComponentType, ReactNode } from "react";
import { formatDetail, reportsFailure, type TimelineItem } from "@/lib/events";
import { resultSummary, toolKind, toolLabel, toolTarget } from "@/lib/tools";
import {
  IconAlert,
  IconCheck,
  IconChevron,
  IconEdit,
  IconFile,
  IconFlask,
  IconList,
  IconPlay,
  IconPulse,
  IconRefresh,
  IconShieldCheck,
  IconSpark,
  IconStop,
  IconTerminal,
  IconX,
  Spinner,
} from "../ui/icons";
import { PlanSteps } from "./PlanPanel";
import { fmtClock } from "./RunHeader";

type Icon = ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";

const ICON_TONE: Record<Tone, string> = {
  neutral: "text-ink-faint",
  accent: "text-accent-strong",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
};
// Left edge marker: only failures and warnings get one, so problems stand out while scanning.
const EDGE: Record<Tone, string> = { neutral: "", accent: "", ok: "", warn: "before:bg-warn", bad: "before:bg-bad" };
const ROW_BG: Record<Tone, string> = { neutral: "", accent: "bg-accent/[0.04]", ok: "", warn: "bg-warn/[0.035]", bad: "bg-bad/[0.045]" };

function offset(ts: number, start: number): string {
  const s = Math.max(0, ts - start);
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

function toolIcon(tool: string): Icon {
  switch (toolKind(tool)) {
    case "write":
      return IconEdit;
    case "app":
      return tool === "stop_app" ? IconStop : tool === "start_app" ? IconPlay : IconRefresh;
    case "check":
      return tool === "run_tests" ? IconFlask : IconPulse;
    case "read":
      return IconFile;
    default:
      return IconTerminal;
  }
}

/** Shared row layout: [time] [icon] [content] [meta]. */
function Row({
  ts,
  start,
  icon,
  tone,
  spinning,
  children,
  meta,
  detail,
}: {
  ts: number;
  start: number;
  icon: Icon;
  tone: Tone;
  spinning?: boolean;
  children: ReactNode;
  meta?: ReactNode;
  detail?: ReactNode;
}) {
  const IconC = icon;
  const head = (
    <div className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-2.5 sm:grid-cols-[52px_18px_minmax(0,1fr)_auto]">
      <time
        dateTime={new Date(ts * 1000).toISOString()}
        title={fmtClock(ts)}
        className="hidden pt-px text-right font-mono text-xs text-ink-faint tabular-nums sm:block"
      >
        {offset(ts, start)}
      </time>
      <span className={`grid h-5 place-items-center ${ICON_TONE[tone]}`}>{spinning ? <Spinner size={12} /> : <IconC size={15} />}</span>
      <div className="min-w-0">{children}</div>
      <div className="flex items-center gap-2 pt-px">
        {meta}
        <span className="font-mono text-xs text-ink-faint tabular-nums sm:hidden">{offset(ts, start)}</span>
        {detail && <IconChevron size={13} className="shrink-0 text-ink-faint transition-transform group-open:rotate-90" />}
      </div>
    </div>
  );
  const base = `animate-enter relative border-b border-line last:border-b-0 ${ROW_BG[tone]} before:absolute before:inset-y-0 before:left-0 before:w-0.5 ${EDGE[tone]}`;
  if (!detail) return <li className={base}>{head}</li>;
  return (
    <li className={base}>
      <details className="group">
        <summary className="cursor-pointer list-none transition-colors hover:bg-raised/50 focus-visible:bg-raised/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-inset">
          {head}
        </summary>
        <div className="px-4 pb-3 sm:pl-[calc(52px+18px+2.5rem)]">{detail}</div>
      </details>
    </li>
  );
}

function Code({ label, text, tone = "muted" }: { label: string; text: string; tone?: "muted" | "bad" }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium text-ink-faint">{label}</p>
      <pre
        className={`max-h-72 overflow-auto rounded-md border border-line bg-sunken p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] ${
          tone === "bad" ? "text-bad/90" : "text-ink-muted"
        }`}
      >
        {text}
      </pre>
    </div>
  );
}

function Check({ name, ok, running }: { name: string; ok?: boolean; running: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      {running ? (
        <Spinner size={11} className="text-accent" />
      ) : ok ? (
        <IconCheck size={14} strokeWidth={2.5} className="text-ok" />
      ) : (
        <IconX size={14} strokeWidth={2.5} className="text-bad" />
      )}
      <span className={running ? "text-ink-muted" : ok ? "text-ink" : "text-bad"}>{name}</span>
      <span className="sr-only">{running ? "running" : ok ? "passed" : "failed"}</span>
    </span>
  );
}

export default function LogRow({ item, start }: { item: TimelineItem; start: number }) {
  switch (item.kind) {
    case "run_started":
      return (
        <Row
          ts={item.ts}
          start={start}
          icon={IconPlay}
          tone="neutral"
          detail={item.tools.length ? <Code label="Available tools" text={item.tools.join("\n")} /> : undefined}
        >
          <p className="text-[13px] text-ink">Agent started</p>
          <p className="text-xs text-ink-faint">
            {item.tools.length} MCP tools{item.maxSteps ? ` · max ${item.maxSteps} steps` : ""}
          </p>
        </Row>
      );

    case "plan":
      return (
        <Row
          ts={item.ts}
          start={start}
          icon={IconList}
          tone="neutral"
          detail={
            <div className="rounded-md border border-line bg-sunken p-3">
              <PlanSteps plan={item.plan} />
            </div>
          }
        >
          <p className="text-[13px] text-ink">{item.revision === 1 ? "Plan created" : "Plan revised"}</p>
          <p className="text-xs text-ink-faint">
            {item.plan.length} steps{item.revision > 1 ? ` · revision ${item.revision}` : ""}
          </p>
        </Row>
      );

    case "status":
      return (
        <Row ts={item.ts} start={start} icon={IconSpark} tone="neutral">
          <p className="text-[13px] break-words text-ink-muted">
            <span className="mr-2 text-xs font-medium text-ink-faint">Agent</span>
            {item.text}
          </p>
        </Row>
      );

    case "tool": {
      const negative = item.state === "ok" && reportsFailure(item.result);
      const running = item.state === "running";
      const tone: Tone = running ? "accent" : item.state === "failed" ? (item.interrupted ? "warn" : "bad") : negative ? "warn" : "ok";
      const target = toolTarget(item.args);
      const summary = item.state === "ok" ? resultSummary(item.tool, item.result) : null;
      const status = running
        ? "Running"
        : item.interrupted
          ? "Interrupted"
          : item.state === "failed"
            ? "Failed"
            : negative
              ? "Reported failure"
              : "OK";
      const hasArgs = !!item.args && typeof item.args === "object" && Object.keys(item.args as object).length > 0;
      const output = item.state === "ok" ? formatDetail(item.result) : "";
      const detail =
        hasArgs || output || item.error ? (
          <div className={`grid gap-3 ${hasArgs && (output || item.error) ? "lg:grid-cols-2" : ""}`}>
            {hasArgs && <Code label="Input" text={formatDetail(item.args)} />}
            {output && <Code label="Output" text={output} />}
            {item.error && <Code label="Error" text={item.error} tone="bad" />}
          </div>
        ) : undefined;
      return (
        <Row
          ts={item.ts}
          start={start}
          icon={toolIcon(item.tool)}
          tone={tone}
          spinning={running}
          detail={detail}
          meta={
            <>
              <span className={`hidden text-xs font-medium sm:inline ${ICON_TONE[tone]}`}>{status}</span>
              {item.durationS !== undefined && (
                <span className="hidden font-mono text-xs text-ink-faint tabular-nums sm:inline">{item.durationS.toFixed(2)}s</span>
              )}
            </>
          }
        >
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px]">
            <span className="font-medium text-ink">{toolLabel(item.tool)}</span>
            {target && <span className="min-w-0 truncate font-mono text-xs text-ink-muted">{target}</span>}
          </p>
          <p className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 text-xs">
            <span className="font-mono text-ink-faint">{item.tool}</span>
            <span className={`sm:hidden ${ICON_TONE[tone]}`}>{status}</span>
            {summary && <span className={`min-w-0 break-words ${negative ? "text-warn" : "text-ink-muted"}`}>{summary}</span>}
            {item.state === "failed" && item.error && <span className="line-clamp-2 min-w-0 break-words text-bad">{item.error}</span>}
          </p>
        </Row>
      );
    }

    case "verification": {
      const running = item.state === "running" && !item.interrupted;
      const passed = item.state === "passed";
      const tone: Tone = running ? "accent" : passed ? "ok" : "warn";
      return (
        <Row ts={item.ts} start={start} icon={IconShieldCheck} tone={tone} spinning={running}>
          <p className="text-[13px] font-semibold text-ink">
            Independent verification
            {item.attempt !== null && <span className="ml-2 font-mono text-xs font-normal text-ink-faint">attempt {item.attempt}</span>}
          </p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {running
              ? "Agent declared recovery. The backend is checking the claim."
              : item.interrupted
                ? "Interrupted before it completed."
                : passed
                  ? "All checks passed."
                  : "Checks failed: the service is not recovered."}
          </p>
          {!item.interrupted && (
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
              <Check name="Restart" ok={item.checks?.restart} running={running} />
              <Check name="Health" ok={item.checks?.health} running={running} />
              <Check name="Tests" ok={item.checks?.tests} running={running} />
            </div>
          )}
        </Row>
      );
    }

    case "terminal": {
      const t =
        item.type === "run_completed"
          ? { icon: IconShieldCheck, tone: "ok" as Tone, title: "Run completed" }
          : item.type === "run_cancelled"
            ? { icon: IconStop, tone: "neutral" as Tone, title: "Run cancelled" }
            : item.status === "unverified"
              ? { icon: IconAlert, tone: "warn" as Tone, title: "Run ended · not verified" }
              : { icon: IconAlert, tone: "bad" as Tone, title: "Run ended · failed" };
      return (
        <Row ts={item.ts} start={start} icon={t.icon} tone={t.tone}>
          <p className={`text-[13px] font-semibold ${ICON_TONE[t.tone] === "text-ink-faint" ? "text-ink" : ICON_TONE[t.tone]}`}>{t.title}</p>
          {item.reason && <p className="mt-0.5 text-xs break-words text-ink-muted">{item.reason}</p>}
        </Row>
      );
    }
  }
}
