"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ACTIVE_STATUSES, ApiError, api, errorMessage, type Health, type Run, type Scenario } from "@/lib/api";
import { useRunEvents } from "@/lib/useRunEvents";
import LaunchPanel from "./LaunchPanel";
import RunSummary from "./RunSummary";
import Timeline from "./Timeline";

const POLL_MS = 1500; // authoritative status refresh while the live stream is not open
const POLL_LIVE_MS = 4000; // slower fallback refresh while SSE is delivering events
const POLL_MAX_MS = 8000;

/** Polling responses can arrive out of order: a run never goes from terminal back to active. */
function mergeRun(prev: Run | null, next: Run): Run | null {
  if (prev && prev.id !== next.id) return prev; // response for a previous run
  if (prev && !ACTIVE_STATUSES.includes(prev.status) && ACTIVE_STATUSES.includes(next.status)) return prev;
  return next;
}

type HealthState = { kind: "loading" } | { kind: "ok"; health: Health } | { kind: "error"; message: string };

function BackendStatus({ state }: { state: HealthState }) {
  const [dot, text] =
    state.kind === "loading"
      ? ["bg-ink-faint animate-pulse", "Connecting…"]
      : state.kind === "error"
        ? ["bg-bad", "Backend unreachable"]
        : state.health.gemini_configured
          ? ["bg-ok", state.health.model]
          : ["bg-warn", "Gemini key not configured"];
  return (
    <div role="status" className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 font-mono text-xs text-ink-muted">
      <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
      <span className="sr-only">Backend status: </span>
      <span className="max-w-[40vw] truncate">{text}</span>
    </div>
  );
}

export default function Dashboard() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [scenarios, setScenarios] = useState<Scenario[] | null>(null);
  const [scenariosError, setScenariosError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [runLost, setRunLost] = useState(false); // backend no longer knows the run (restart)
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Retry re-checks health too: otherwise launch stays blocked after the backend recovers.
  const reconnect = useCallback(async () => {
    setScenariosError(null);
    setScenarios(null);
    setHealth({ kind: "loading" });
    const [h, sc] = await Promise.allSettled([api.health(), api.scenarios()]);
    setHealth(h.status === "fulfilled" ? { kind: "ok", health: h.value } : { kind: "error", message: errorMessage(h.reason) });
    if (sc.status === "fulfilled") setScenarios(sc.value);
    else setScenariosError(errorMessage(sc.reason));
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const h = await api.health();
        if (alive) setHealth({ kind: "ok", health: h });
      } catch (err) {
        if (alive) setHealth({ kind: "error", message: errorMessage(err) });
      }
    })();
    (async () => {
      try {
        const s = await api.scenarios();
        if (alive) setScenarios(s);
      } catch (err) {
        if (alive) setScenariosError(errorMessage(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const runId = run?.id ?? null;
  const runActive = run && !runLost ? ACTIVE_STATUSES.includes(run.status) : false;

  // Terminal SSE event: fetch the authoritative final summary now instead of at the next poll.
  const refreshNow = useCallback(() => {
    if (!runId) return;
    api.getRun(runId).then((next) => setRun((prev) => mergeRun(prev, next)), () => undefined);
  }, [runId]);

  // Live timeline (SSE). It never changes run status; GET /runs/{id} stays authoritative.
  const { timeline, connection, retry } = useRunEvents(runId, !!runId && !runLost, refreshNow);
  // Read through a ref: restarting the poll loop on every connection change would reset its
  // timer, and a flapping stream could postpone the authoritative status refresh indefinitely.
  const pollMsRef = useRef(POLL_MS);
  useEffect(() => {
    pollMsRef.current = connection === "open" ? POLL_LIVE_MS : POLL_MS;
  }, [connection]);

  // Poll the run summary while it is active.
  useEffect(() => {
    if (!runId || !runActive) return;
    let alive = true;
    let delay = pollMsRef.current;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await api.getRun(runId);
        if (!alive) return;
        setRun((prev) => mergeRun(prev, next));
        setPollError(null);
        delay = pollMsRef.current;
        if (ACTIVE_STATUSES.includes(next.status)) timer = setTimeout(tick, delay);
      } catch (err) {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) {
          setPollError("This run no longer exists on the server (the backend may have restarted).");
          setRunLost(true);
          return;
        }
        setPollError(`Status update failed: ${errorMessage(err)} Retrying…`);
        delay = Math.min(delay * 2, POLL_MAX_MS);
        timer = setTimeout(tick, delay);
      }
    };
    timer = setTimeout(tick, delay);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runId, runActive]);

  async function launch(goal: string, scenario: string) {
    setLaunching(true);
    setLaunchError(null);
    setPollError(null);
    setRunLost(false);
    setCancelError(null);
    try {
      setRun(await api.createRun(goal, scenario));
    } catch (err) {
      setLaunchError(
        err instanceof ApiError && err.status === 429
          ? `The agent is busy: ${err.message}`
          : errorMessage(err),
      );
    } finally {
      setLaunching(false);
    }
  }

  async function cancel() {
    if (!run) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await api.cancelRun(run.id);
      const next = await api.getRun(run.id);
      setRun((prev) => mergeRun(prev, next));
    } catch (err) {
      // 409: it finished first; refresh to show the final state.
      if (err instanceof ApiError && err.status === 409) {
        api.getRun(run.id).then((next) => setRun((prev) => mergeRun(prev, next)), () => undefined);
      } else {
        setCancelError(`Cancel failed: ${errorMessage(err)}`);
      }
    } finally {
      setCancelling(false);
    }
  }

  const canLaunch = health.kind === "ok" && health.health.gemini_configured;
  const busy = runActive;

  return (
    <div className="console-grid min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg border border-accent/40 bg-accent/10 font-mono text-sm font-semibold text-accent">
              R
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold tracking-tight text-ink">RescueOps</h1>
              <p className="truncate text-xs text-ink-faint">Autonomous DevOps Recovery Agent</p>
            </div>
          </div>
          <BackendStatus state={health} />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        {health.kind === "error" && (
          <div role="alert" className="mb-6 rounded-lg border border-bad/30 bg-bad/5 px-4 py-3 text-sm text-bad">
            {health.message} Check that the API is running and <code className="font-mono">NEXT_PUBLIC_API_URL</code> points to it.
          </div>
        )}
        {health.kind === "ok" && !health.health.gemini_configured && (
          <div role="alert" className="mb-6 rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-warn">
            The backend has no Gemini API key configured, so runs cannot start.
          </div>
        )}

        {/* DOM order (mobile): launch, summary, timeline. Desktop: summary spans both rows on the right. */}
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-7">
            <LaunchPanel
              scenarios={scenarios}
              scenariosError={scenariosError}
              onRetryScenarios={reconnect}
              launching={launching}
              launchError={launchError}
              busy={busy}
              canLaunch={canLaunch}
              onLaunch={launch}
            />
          </div>
          <div className="min-w-0 lg:col-span-5 lg:col-start-8 lg:row-span-2 lg:row-start-1">
            <RunSummary
              run={run}
              livePlan={timeline.plan}
              liveEventCount={timeline.eventCount}
              lost={runLost}
              pollError={pollError}
              cancelling={cancelling}
              cancelError={cancelError}
              onCancel={cancel}
            />
          </div>
          {run && (
            <div className="min-w-0 lg:col-span-7">
              <Timeline key={run.id} timeline={timeline} connection={connection} lost={runLost} onRetry={retry} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
