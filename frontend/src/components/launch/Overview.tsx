import { API_URL, type HealthState } from "@/lib/api";
import { IconRoute, IconSearch, IconShieldCheck, IconWrench } from "../ui/icons";
import { Dot, KeyValue, Panel } from "../ui/primitives";

const STEPS = [
  { Icon: IconSearch, title: "Diagnose", text: "Status, logs, config, code" },
  { Icon: IconRoute, title: "Plan", text: "Picks tools, replans on failure" },
  { Icon: IconWrench, title: "Repair", text: "Edits files in the sandbox" },
  { Icon: IconShieldCheck, title: "Verify", text: "Restart, health check, tests" },
];

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export default function Overview({ health }: { health: HealthState }) {
  const ok = health.kind === "ok";
  return (
    <aside className="grid content-start gap-4 sm:grid-cols-2 xl:grid-cols-1">
      <Panel title="Recovery pipeline" labelledBy="pipeline-title" bodyClassName="p-0">
        <ol className="divide-y divide-line">
          {STEPS.map(({ Icon, title, text }, i) => (
            <li key={title} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-4 shrink-0 font-mono text-xs text-ink-faint tabular-nums">{i + 1}</span>
              <Icon size={15} className="shrink-0 text-accent-strong" />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-ink">{title}</span>
                <span className="block truncate text-xs text-ink-faint">{text}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="border-t border-line px-4 py-2.5 text-xs text-ink-faint">
          Success requires all independent checks to pass, regardless of what the agent reports.
        </p>
      </Panel>

      <Panel title="Environment" labelledBy="env-title" bodyClassName="px-4 py-2">
        <dl className="divide-y divide-line">
          <KeyValue label="API">
            <span className="inline-flex items-center gap-2">
              <Dot tone={health.kind === "loading" ? "neutral" : ok ? "ok" : "bad"} />
              {health.kind === "loading" ? "Checking" : ok ? "Connected" : "Offline"}
            </span>
          </KeyValue>
          <KeyValue label="Endpoint" mono>
            {API_URL ? host(API_URL) : "not configured"}
          </KeyValue>
          <KeyValue label="Model" mono>
            {ok ? health.health.model : "—"}
          </KeyValue>
          <KeyValue label="Isolation">Fresh sandbox per run</KeyValue>
          <KeyValue label="Agent access">MCP tools only, no shell</KeyValue>
          <KeyValue label="Tests & logs">Read-only to agent</KeyValue>
        </dl>
      </Panel>
    </aside>
  );
}
