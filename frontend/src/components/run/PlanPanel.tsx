import type { PlanStep } from "@/lib/api";
import { IconCheck, IconList, IconX } from "../ui/icons";
import { Panel } from "../ui/primitives";

function StepMark({ status }: { status: PlanStep["status"] }) {
  const base = "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border";
  switch (status) {
    case "done":
      return <span className={`${base} border-ok/60 bg-ok/15 text-ok`}><IconCheck size={9} strokeWidth={3.5} /></span>;
    case "failed":
      return <span className={`${base} border-bad/60 bg-bad/15 text-bad`}><IconX size={9} strokeWidth={3.5} /></span>;
    case "in_progress":
      return <span className={`${base} border-accent/70`}><span className="size-1.5 rounded-full bg-accent" /></span>;
    case "skipped":
      return <span className={`${base} border-line text-ink-faint`}><span className="h-px w-1.5 bg-current" /></span>;
    default:
      return <span className={`${base} border-line-strong`} />;
  }
}

export function PlanSteps({ plan }: { plan: PlanStep[] }) {
  return (
    <ol className="space-y-2">
      {plan.map((s, i) => (
        <li key={i} className="flex gap-2.5">
          <StepMark status={s.status} />
          <span className={`min-w-0 text-[13px] leading-snug break-words ${s.status === "done" ? "text-ink-muted" : "text-ink"}`}>
            {s.step}
            <span className="sr-only"> ({s.status.replace("_", " ")})</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function PlanPanel({ plan, revisions, active }: { plan: PlanStep[]; revisions: number; active: boolean }) {
  return (
    <Panel
      title="Recovery plan"
      icon={<IconList size={14} />}
      labelledBy="plan-title"
      actions={revisions > 1 ? <span className="font-mono text-xs text-ink-faint">rev {revisions}</span> : undefined}
    >
      {plan.length ? (
        <PlanSteps plan={plan} />
      ) : (
        <p className="text-[13px] text-ink-faint">{active ? "Waiting for the agent's plan…" : "No plan was published."}</p>
      )}
    </Panel>
  );
}
