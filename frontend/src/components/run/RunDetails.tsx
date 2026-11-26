import type { HealthState, Run, Scenario } from "@/lib/api";
import type { ConnectionState } from "@/lib/stream";
import { scenarioCopy } from "../launch/scenarios";
import { IconLock } from "../ui/icons";
import { Dot, KeyValue, Panel, streamState } from "../ui/primitives";
import { fmtClock } from "./RunHeader";

interface Props {
  run: Run;
  scenarios: Scenario[] | null;
  health: HealthState;
  connection: ConnectionState;
  lost: boolean;
}

export default function RunDetails({ run, scenarios, health, connection, lost }: Props) {
  const sc = scenarioCopy(run.scenario);
  const fault = scenarios?.find((s) => s.id === run.scenario)?.description;
  const [tone, label] = streamState(connection, lost);
  return (
    <Panel title="Run details" labelledBy="details-title" bodyClassName="px-4 py-2">
      <dl className="divide-y divide-line">
        <KeyValue label="Environment">{sc.title}</KeyValue>
        {fault && (
          <div className="py-2">
            <dt className="flex items-center gap-1.5 text-[13px] text-ink-faint">
              <IconLock size={12} /> Injected fault <span className="text-xs">(hidden from agent)</span>
            </dt>
            <dd className="mt-1 flex items-center gap-2 font-mono text-xs text-ink-muted">
              <span aria-hidden className="h-3.5 w-0.5 shrink-0 rounded-full bg-warn/80" />
              <span className="break-words">{fault}</span>
            </dd>
          </div>
        )}
        <KeyValue label="Started" mono>
          {fmtClock(run.started_at ?? run.created_at)}
        </KeyValue>
        {health.kind === "ok" && (
          <KeyValue label="Model" mono>
            {health.health.model}
          </KeyValue>
        )}
        <KeyValue label="Event stream">
          <span className="inline-flex items-center gap-2">
            <Dot tone={tone} pulse={connection === "reconnecting" && !lost} />
            {label}
          </span>
        </KeyValue>
      </dl>
    </Panel>
  );
}
