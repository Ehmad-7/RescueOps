"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ACTIVE_STATUSES, ApiError, api, errorMessage, mergeRun, type HealthState, type Run, type Scenario } from "@/lib/api";
import { useRunEvents } from "@/lib/useRunEvents";
import AppHeader from "./AppHeader";
import LaunchView from "./launch/LaunchView";
import RunWorkspace from "./run/RunWorkspace";

const POLL_MS = 1500; // authoritative status refresh while the live stream is not open
const POLL_LIVE_MS = 4000; // slower fallback refresh while SSE is delivering events
const POLL_MAX_MS = 8000;

const fetchBackend = () => Promise.allSettled([api.health(), api.scenarios()]);
type BackendResult = Awaited<ReturnType<typeof fetchBackend>>;

export default function Dashboard() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [scenarios, setScenarios] = useState<Scenario[] | null>(null);
  const [scenariosError, setScenariosError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [scenario, setScenario] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [runLost, setRunLost] = useState(false); // backend no longer knows the run (restart)
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const launchingRef = useRef(false); // synchronous guard: one POST /runs at a time

  // Health + scenarios: fetched together on mount and on every Retry (Retry must re-check health
  // too, otherwise launch stays blocked after the backend recovers).
  const applyBackend = useCallback(([h, sc]: BackendResult) => {
    setHealth(h.status === "fulfilled" ? { kind: "ok", health: h.value } : { kind: "error", message: errorMessage(h.reason) });
    if (sc.status === "fulfilled") setScenarios(sc.value);
    else setScenariosError(errorMessage(sc.reason));
  }, []);

  const reconnect = useCallback(() => {
    setScenariosError(null);
    setScenarios(null);
    setHealth({ kind: "loading" });
    fetchBackend().then(applyBackend);
  }, [applyBackend]);

  useEffect(() => {
    let alive = true;
    fetchBackend().then((r) => {
      if (alive) applyBackend(r);
    });
    return () => {
      alive = false;
    };
  }, [applyBackend]);

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

  async function launch() {
    const sc = scenario ?? scenarios?.[0]?.id;
    if (!sc || launchingRef.current) return;
    launchingRef.current = true;
    setLaunching(true);
    setLaunchError(null);
    setPollError(null);
    setRunLost(false);
    setCancelError(null);
    try {
      const created = await api.createRun(goal.trim(), sc);
      setRun(created);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setLaunchError(
        err instanceof ApiError && err.status === 429 ? `The agent is busy: ${err.message}` : errorMessage(err),
      );
    } finally {
      launchingRef.current = false;
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

  // Back to the launch view (only offered once the run is no longer active). Inputs are kept.
  function startNew() {
    setRun(null);
    setRunLost(false);
    setPollError(null);
    setCancelError(null);
    setLaunchError(null);
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="min-h-screen">
      <AppHeader health={health} degraded={!!pollError && !runLost} context={run ? `Recovery ${run.id}` : "New recovery"} />
      <main className="mx-auto w-full max-w-[90rem] px-4 pt-6 pb-16 sm:px-6 lg:pt-8">
        {run ? (
          <RunWorkspace
            key={run.id}
            run={run}
            scenarios={scenarios}
            health={health}
            timeline={timeline}
            connection={connection}
            lost={runLost}
            pollError={pollError}
            cancelling={cancelling}
            cancelError={cancelError}
            onCancel={cancel}
            onRetryStream={retry}
            onNewRun={startNew}
          />
        ) : (
          <LaunchView
            health={health}
            scenarios={scenarios}
            scenariosError={scenariosError}
            goal={goal}
            onGoalChange={setGoal}
            scenario={scenario}
            onScenarioChange={setScenario}
            launching={launching}
            launchError={launchError}
            onLaunch={launch}
            onReconnect={reconnect}
          />
        )}
      </main>
    </div>
  );
}
