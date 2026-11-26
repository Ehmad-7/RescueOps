"use client";

import { useId, type FormEvent } from "react";
import { GOAL_MAX, GOAL_MIN, type HealthState, type Scenario } from "@/lib/api";
import { IconAlert, IconCheck, IconLock, IconPlay } from "../ui/icons";
import { Button, SectionLabel } from "../ui/primitives";
import BackendNotice from "./BackendNotice";
import { scenarioCopy } from "./scenarios";

const EXAMPLES = [
  { label: "Failing after deploy", text: "The inventory API started failing right after this morning's deploy. Find the root cause and restore the service." },
  { label: "Service won't start", text: "Our service won't start anymore. Investigate the logs and configuration, fix the problem, and confirm it's healthy." },
  { label: "Health checks failing", text: "Health checks are failing in production. Diagnose why and recover the application." },
];

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

function ScenarioOption({ s, on, onSelect }: { s: Scenario; on: boolean; onSelect: () => void }) {
  const c = scenarioCopy(s.id);
  return (
    <label
      className={`relative flex cursor-pointer flex-col rounded-md border transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/60 ${
        on ? "border-accent/70 bg-accent/[0.06]" : "border-line-strong bg-sunken hover:border-ink-faint/50"
      }`}
    >
      <input type="radio" name="scenario" value={s.id} checked={on} onChange={onSelect} className="sr-only" />
      <span className="flex items-start gap-3 p-3">
        <c.Icon size={16} className={`mt-0.5 shrink-0 ${on ? "text-accent-strong" : "text-ink-faint"}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">{c.title}</span>
          {c.subtitle && <span className="mt-0.5 block text-[13px] text-ink-muted">{c.subtitle}</span>}
        </span>
        <span
          aria-hidden
          className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${on ? "border-accent bg-accent text-accent-ink" : "border-line-strong"}`}
        >
          {on && <IconCheck size={10} strokeWidth={3.5} />}
        </span>
      </span>
      <span className="mt-auto flex items-center gap-2 border-t border-line px-3 py-2">
        <span aria-hidden className="h-3.5 w-0.5 shrink-0 rounded-full bg-warn/80" />
        <span className="min-w-0 truncate font-mono text-xs text-ink-muted" title={s.description}>
          <span className="sr-only">Injected fault: </span>
          {s.description}
        </span>
      </span>
    </label>
  );
}

export default function LaunchForm(p: Props) {
  const goalId = useId();
  const countId = useId();
  const errId = useId();
  const trimmed = p.goal.trim();
  const tooShort = trimmed.length < GOAL_MIN;
  const touched = p.goal.length > 0;
  const ready = p.health.kind === "ok" && p.health.health.gemini_configured;
  const selected = p.scenario ?? p.scenarios?.[0]?.id ?? null;
  const disabled = !ready || p.launching || tooShort || !selected;
  const blocker = !ready ? "Backend not ready" : !selected ? "Select an environment" : tooShort ? "Describe the incident" : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!disabled) p.onLaunch();
  }

  return (
    <form onSubmit={submit} aria-label="New recovery" className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
      <BackendNotice health={p.health} onRetry={p.onReconnect} />

      {/* Incident */}
      <div className="space-y-2.5 p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-3">
          <SectionLabel htmlFor={goalId}>Incident</SectionLabel>
          <span id={countId} className={`font-mono text-xs tabular-nums ${touched && tooShort ? "text-bad" : "text-ink-faint"}`}>
            {trimmed.length}/{GOAL_MAX}
          </span>
        </div>
        <textarea
          id={goalId}
          value={p.goal}
          onChange={(e) => p.onGoalChange(e.target.value)}
          maxLength={GOAL_MAX}
          rows={4}
          aria-describedby={`${countId}${touched && tooShort ? ` ${errId}` : ""}`}
          aria-invalid={touched && tooShort}
          placeholder="What's broken? e.g. Checkout requests have been failing since the last deploy. Find the cause and restore the service."
          className="block w-full resize-y rounded-md border border-line-strong bg-sunken px-3 py-2.5 text-sm leading-relaxed text-ink transition-colors placeholder:text-ink-faint hover:border-ink-faint/50 focus:border-accent/70 focus:ring-2 focus:ring-accent/20 focus:outline-none"
        />
        {touched && tooShort && (
          <p id={errId} className="text-[13px] text-bad">
            Add a little more detail (at least {GOAL_MIN} characters).
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
          <span className="mr-1 text-xs text-ink-faint">Examples</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              title={ex.text}
              onClick={() => p.onGoalChange(ex.text)}
              className="rounded px-1.5 py-0.5 text-xs text-accent-strong transition-colors hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none"
            >
              {ex.label}
            </button>
          ))}
        </div>
      </div>

      {/* Environment */}
      <fieldset className="border-t border-line p-4 sm:p-5">
        <legend className="sr-only">Environment</legend>
        <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <SectionLabel>Environment</SectionLabel>
          <span className="flex items-center gap-1.5 text-xs text-ink-faint">
            <IconLock size={12} /> Injected fault is hidden from the agent
          </span>
        </div>
        {p.scenariosError ? (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-bad/30 bg-bad/[0.06] px-3 py-2.5 text-[13px] text-bad">
            <span className="flex items-center gap-2">
              <IconAlert size={14} /> Could not load environments: {p.scenariosError}
            </span>
            <Button size="sm" variant="ghost" onClick={p.onReconnect}>
              Retry
            </Button>
          </div>
        ) : p.scenarios === null ? (
          <div className="grid gap-2.5 md:grid-cols-3" aria-busy="true" aria-label="Loading environments">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[104px] animate-pulse rounded-md border border-line bg-raised/50" />
            ))}
          </div>
        ) : p.scenarios.length === 0 ? (
          <p className="text-[13px] text-ink-muted">The backend reported no environments.</p>
        ) : (
          <div className="grid gap-2.5 md:grid-cols-3">
            {p.scenarios.map((s) => (
              <ScenarioOption key={s.id} s={s} on={s.id === selected} onSelect={() => p.onScenarioChange(s.id)} />
            ))}
          </div>
        )}
      </fieldset>

      {p.launchError && (
        <div role="alert" className="flex items-start gap-2 border-t border-line bg-bad/[0.06] px-4 py-3 text-[13px] text-bad sm:px-5">
          <IconAlert size={14} className="mt-0.5 shrink-0" />
          {p.launchError}
        </div>
      )}

      {/* Action */}
      <div className="flex flex-col-reverse gap-3 border-t border-line bg-canvas/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <p className="text-[13px] text-ink-faint">
          {blocker ?? "The agent runs autonomously until it verifies a fix, fails, or is cancelled."}
        </p>
        <Button type="submit" variant="primary" size="lg" disabled={disabled} loading={p.launching} icon={<IconPlay size={14} />}>
          {p.launching ? "Starting…" : "Start recovery"}
        </Button>
      </div>
    </form>
  );
}
