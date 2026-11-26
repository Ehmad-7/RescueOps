"use client";

import { useId, useState, type FormEvent } from "react";
import { GOAL_MAX, GOAL_MIN, type Scenario } from "@/lib/api";

export const DEFAULT_GOAL = "Investigate why my application is broken and recover it.";

interface Props {
  scenarios: Scenario[] | null; // null while loading
  scenariosError: string | null;
  onRetryScenarios: () => void;
  launching: boolean;
  launchError: string | null;
  busy: boolean; // a run is active
  canLaunch: boolean; // backend reachable and configured
  onLaunch: (goal: string, scenario: string) => void;
}

export default function LaunchPanel(p: Props) {
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [picked, setPicked] = useState<string | null>(null);
  const goalId = useId();
  const hintId = useId();

  // Default to the first scenario the API returns, until the user picks one.
  const scenario = picked ?? p.scenarios?.[0]?.id ?? null;
  const trimmed = goal.trim();
  const goalValid = trimmed.length >= GOAL_MIN && trimmed.length <= GOAL_MAX;
  const disabled = !p.canLaunch || p.launching || p.busy || !goalValid || !scenario;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!disabled && scenario) p.onLaunch(trimmed, scenario);
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-surface" aria-labelledby="launch-title">
      <header className="border-b border-line px-5 py-4">
        <h2 id="launch-title" className="text-sm font-medium text-ink">
          New recovery run
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Describe the incident. The agent investigates a fresh, isolated copy of the service and
          only reports success after independent checks pass.
        </p>
      </header>

      <div className="space-y-6 px-5 py-5">
        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor={goalId} className="text-xs font-medium tracking-wide text-ink-muted uppercase">
              Recovery goal
            </label>
            <span
              id={hintId}
              className={`font-mono text-xs ${goalValid ? "text-ink-faint" : "text-bad"}`}
              aria-live="polite"
            >
              {trimmed.length}/{GOAL_MAX}
            </span>
          </div>
          <textarea
            id={goalId}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            maxLength={GOAL_MAX}
            rows={4}
            required
            aria-describedby={hintId}
            aria-invalid={!goalValid}
            className="mt-2 block w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/20 focus:outline-none"
            placeholder="e.g. Checkout API returns 500s since the last deploy. Find the cause and recover it."
          />
          {!goalValid && (
            <p className="mt-1.5 text-xs text-bad">
              Goal must be between {GOAL_MIN} and {GOAL_MAX} characters.
            </p>
          )}
        </div>

        <fieldset>
          <legend className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            Failure scenario
          </legend>
          <p className="mt-1 text-xs text-ink-faint">
            Injected into the sandbox. The agent only receives your goal, never the scenario.
          </p>

          {p.scenariosError ? (
            <div role="alert" className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2.5 text-sm text-bad">
              <span>Could not load scenarios: {p.scenariosError}</span>
              <button
                type="button"
                onClick={p.onRetryScenarios}
                className="shrink-0 rounded-md border border-bad/40 px-2 py-1 text-xs hover:bg-bad/10 focus-visible:ring-2 focus-visible:ring-bad/40 focus-visible:outline-none"
              >
                Retry
              </button>
            </div>
          ) : p.scenarios === null ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-3" aria-busy="true" aria-label="Loading scenarios">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[74px] animate-pulse rounded-lg border border-line bg-raised" />
              ))}
            </div>
          ) : p.scenarios.length === 0 ? (
            <p className="mt-3 rounded-lg border border-line px-3 py-2.5 text-sm text-ink-muted">
              The backend reported no scenarios.
            </p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {p.scenarios.map((s) => {
                const checked = s.id === scenario;
                return (
                  <label
                    key={s.id}
                    className={`relative flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/70 ${
                      checked ? "border-accent/50 bg-accent/5" : "border-line bg-canvas hover:border-line-strong"
                    }`}
                  >
                    <input
                      type="radio"
                      name="scenario"
                      value={s.id}
                      checked={checked}
                      onChange={() => setPicked(s.id)}
                      className="sr-only"
                    />
                    <span className={`font-mono text-xs ${checked ? "text-accent" : "text-ink"}`}>{s.id}</span>
                    <span className="text-xs leading-snug text-ink-muted">{s.description}</span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>

        {p.launchError && (
          <div role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2.5 text-sm text-bad">
            {p.launchError}
          </div>
        )}
      </div>

      <footer className="flex flex-col-reverse gap-3 border-t border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-ink-faint">
          {p.busy
            ? "A run is in progress. Wait for it to finish or cancel it."
            : !p.canLaunch
              ? "Launch is unavailable until the backend is reachable and configured."
              : "Runs are bounded by step, tool-call and time limits."}
        </p>
        <button
          type="submit"
          disabled={disabled}
          aria-busy={p.launching}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        >
          {p.launching && (
            <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-accent-ink/30 border-t-accent-ink" />
          )}
          {p.launching ? "Starting…" : "Start recovery"}
        </button>
      </footer>
    </form>
  );
}
