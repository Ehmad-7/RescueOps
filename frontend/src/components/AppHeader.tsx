import { API_URL, type HealthState } from "@/lib/api";
import { Dot, type Tone } from "./ui/primitives";
import { IconLogo } from "./ui/icons";

function BackendStatus({ health, degraded }: { health: HealthState; degraded: boolean }) {
  const [tone, label, detail]: [Tone, string, string] = degraded
    ? ["warn", "Connection issues", "Run status updates are failing; retrying"]
    : health.kind === "loading"
      ? ["neutral", "Connecting", "Checking backend…"]
      : health.kind === "error"
        ? ["bad", "API offline", health.message]
        : health.health.gemini_configured
          ? ["ok", "API connected", `Gemini model: ${health.health.model}`]
          : ["warn", "Gemini key missing", "Backend is up but has no Gemini API key"];
  return (
    <div role="status" title={`${detail}${API_URL ? ` · ${API_URL}` : ""}`} className="flex min-w-0 items-center gap-2 text-[13px]">
      <Dot tone={tone} pulse={health.kind === "loading" || degraded} />
      <span className="sr-only">Backend status: </span>
      <span className="whitespace-nowrap text-ink-muted">{label}</span>
      {!degraded && health.kind === "ok" && health.health.gemini_configured && (
        <>
          <span aria-hidden className="hidden h-4 w-px bg-line-strong sm:block" />
          <span className="hidden truncate font-mono text-xs text-ink-faint sm:inline">{health.health.model}</span>
        </>
      )}
    </div>
  );
}

export default function AppHeader({ health, degraded = false, context }: { health: HealthState; degraded?: boolean; context: string }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[90rem] items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md border border-accent/30 bg-accent/10 text-accent-strong">
            <IconLogo size={16} />
          </span>
          <span className="text-sm font-semibold tracking-tight text-ink">RescueOps</span>
          <span aria-hidden className="hidden text-line-strong sm:inline">/</span>
          <span className="hidden truncate text-sm text-ink-muted sm:inline">{context}</span>
        </div>
        <BackendStatus health={health} degraded={degraded} />
      </div>
    </header>
  );
}
