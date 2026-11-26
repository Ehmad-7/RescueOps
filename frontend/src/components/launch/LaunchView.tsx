import type { HealthState, Scenario } from "@/lib/api";
import LaunchForm from "./LaunchForm";
import Overview from "./Overview";

interface Props {
  health: HealthState;
  scenarios: Scenario[] | null;
  scenariosError: string | null;
  goal: string;
  onGoalChange: (v: string) => void;
  scenario: string | null;
  onScenarioChange: (id: string) => void;
  launching: boolean;
  launchError: string | null;
  onLaunch: () => void;
  onReconnect: () => void;
}

export default function LaunchView(p: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">New recovery</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Describe an incident. The agent diagnoses, repairs and independently verifies it in an isolated sandbox.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <LaunchForm
          health={p.health}
          scenarios={p.scenarios}
          scenariosError={p.scenariosError}
          goal={p.goal}
          onGoalChange={p.onGoalChange}
          scenario={p.scenario}
          onScenarioChange={p.onScenarioChange}
          launching={p.launching}
          launchError={p.launchError}
          onLaunch={p.onLaunch}
          onReconnect={p.onReconnect}
        />
        <Overview health={p.health} />
      </div>
    </div>
  );
}
