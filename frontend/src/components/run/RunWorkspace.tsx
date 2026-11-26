import { ACTIVE_STATUSES, type HealthState, type Run, type Scenario } from "@/lib/api";
import type { TimelineState } from "@/lib/events";
import type { ConnectionState } from "@/lib/stream";
import { IconAlert } from "../ui/icons";
import ExecutionLog from "./ExecutionLog";
import OutcomePanel from "./OutcomePanel";
import PlanPanel from "./PlanPanel";
import RunDetails from "./RunDetails";
import RunHeader from "./RunHeader";

interface Props {
  run: Run;
  scenarios: Scenario[] | null;
  health: HealthState;
  timeline: TimelineState;
  connection: ConnectionState;
  lost: boolean;
  pollError: string | null;
  cancelling: boolean;
  cancelError: string | null;
  onCancel: () => void;
  onRetryStream: () => void;
  onNewRun: () => void;
}

export default function RunWorkspace(p: Props) {
  const terminal = p.lost || !ACTIVE_STATUSES.includes(p.run.status);
  const plan = p.timeline.plan?.length ? p.timeline.plan : p.run.plan?.length ? p.run.plan : (p.run.result?.plan ?? []);
  const eventCount = Math.max(p.run.event_count, p.timeline.eventCount);

  return (
    <div className="space-y-4">
      <RunHeader
        run={p.run}
        timeline={p.timeline}
        lost={p.lost}
        eventCount={eventCount}
        cancelling={p.cancelling}
        onCancel={p.onCancel}
        onNewRun={p.onNewRun}
      />

      {(p.pollError || p.cancelError) && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/[0.06] px-4 py-2.5 text-[13px] text-warn">
          <IconAlert size={14} className="mt-0.5 shrink-0" />
          {p.cancelError ?? p.pollError}
        </div>
      )}

      {terminal && <OutcomePanel run={p.run} timeline={p.timeline} lost={p.lost} />}

      {/* Mobile order: plan, log, details. Desktop: log left, plan + details right. */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-[auto_1fr] xl:items-start">
        <div className="min-w-0 xl:col-start-2 xl:row-start-1">
          <PlanPanel plan={plan} revisions={p.timeline.planRevisions} active={!terminal} />
        </div>
        <div className="min-w-0 xl:col-start-1 xl:row-span-2 xl:row-start-1">
          <ExecutionLog timeline={p.timeline} connection={p.connection} lost={p.lost} onRetry={p.onRetryStream} />
        </div>
        <div className="min-w-0 xl:col-start-2 xl:row-start-2">
          <RunDetails run={p.run} scenarios={p.scenarios} health={p.health} connection={p.connection} lost={p.lost} />
        </div>
      </div>
    </div>
  );
}
