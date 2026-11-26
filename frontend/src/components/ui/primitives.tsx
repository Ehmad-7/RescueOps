// Shared design-system primitives. Every screen composes these so spacing, type and states match.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { RunStatus } from "@/lib/api";
import type { ConnectionState } from "@/lib/stream";
import { Spinner } from "./icons";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANT: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-ink hover:bg-accent-strong disabled:bg-raised disabled:text-ink-faint disabled:border-line border border-transparent font-semibold",
  secondary: "border border-line-strong bg-raised text-ink hover:border-ink-faint/60 hover:bg-[#1e2228] disabled:text-ink-faint",
  ghost: "text-ink-muted hover:bg-raised hover:text-ink disabled:text-ink-faint",
  danger: "border border-line-strong bg-raised text-ink hover:border-bad/60 hover:text-bad disabled:text-ink-faint",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
}) {
  const sz = size === "sm" ? "h-7 gap-1.5 px-2.5 text-[13px]" : size === "lg" ? "h-10 gap-2 px-4 text-sm" : "h-8 gap-2 px-3 text-[13px]";
  return (
    <button
      type="button"
      {...rest}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-medium transition-colors disabled:cursor-not-allowed ${sz} ${VARIANT[variant]} ${FOCUS} ${className}`}
    >
      {loading ? <Spinner size={13} /> : icon}
      {children}
    </button>
  );
}

/** Flat panel with an optional header row. Hierarchy comes from surface + one border, not nesting. */
export function Panel({
  title,
  icon,
  actions,
  children,
  className = "",
  bodyClassName = "p-4",
  labelledBy,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  labelledBy?: string;
}) {
  return (
    <section aria-labelledby={labelledBy} className={`rounded-lg border border-line bg-surface ${className}`}>
      {title && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
          <h2 id={labelledBy} className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-ink">
            {icon && <span className="shrink-0 text-ink-faint">{icon}</span>}
            <span className="truncate">{title}</span>
          </h2>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export type Tone = "accent" | "ok" | "warn" | "bad" | "neutral";
const DOT: Record<Tone, string> = { accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", neutral: "bg-ink-faint" };
const TEXT: Record<Tone, string> = { accent: "text-accent-strong", ok: "text-ok", warn: "text-warn", bad: "text-bad", neutral: "text-ink-muted" };

export function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${DOT[tone]} ${pulse ? "animate-pulse" : ""}`} />;
}

export function toneText(t: Tone) {
  return TEXT[t];
}

const RUN: Record<RunStatus | "unknown", { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "accent" },
  verified: { label: "Verified", tone: "ok" },
  unverified: { label: "Unverified", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  unknown: { label: "Unknown", tone: "bad" },
};

/** Run status indicator (the only pill-shaped element in the app). */
export function StatusBadge({ status }: { status: RunStatus | "unknown" }) {
  const s = RUN[status];
  return (
    <span className={`inline-flex h-7 items-center gap-2 rounded-full border border-line-strong bg-raised px-3 text-[13px] font-medium ${TEXT[s.tone]}`}>
      <Dot tone={s.tone} pulse={status === "running" || status === "queued"} />
      {s.label}
    </span>
  );
}

const STREAM: Record<ConnectionState, [Tone, string]> = {
  idle: ["neutral", "Idle"],
  connecting: ["neutral", "Connecting"],
  open: ["ok", "Live"],
  reconnecting: ["warn", "Reconnecting"],
  closed: ["neutral", "Ended"],
  error: ["bad", "Disconnected"],
};

/** Event-stream state as [tone, label]; a lost run is always shown as disconnected. */
export function streamState(connection: ConnectionState, lost: boolean): [Tone, string] {
  return lost ? ["bad", "Disconnected"] : STREAM[connection];
}

/** Compact definition list row for technical metadata. */
export function KeyValue({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-[13px] text-ink-faint">{label}</dt>
      <dd className={`min-w-0 truncate text-right text-[13px] text-ink ${mono ? "font-mono" : ""}`}>{children}</dd>
    </div>
  );
}

export function SectionLabel({ children, htmlFor, id }: { children: ReactNode; htmlFor?: string; id?: string }) {
  const cls = "text-xs font-semibold tracking-wide text-ink-faint uppercase";
  return htmlFor ? (
    <label htmlFor={htmlFor} id={id} className={cls}>
      {children}
    </label>
  ) : (
    <p id={id} className={cls}>
      {children}
    </p>
  );
}
