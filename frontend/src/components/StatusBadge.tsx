import type { RunStatus } from "@/lib/api";

const STYLES: Record<RunStatus | "unknown", { label: string; cls: string; dot: string }> = {
  queued: { label: "Queued", cls: "text-ink-muted border-line-strong", dot: "bg-ink-faint" },
  running: { label: "Running", cls: "text-info border-info/30 bg-info/5", dot: "bg-info animate-pulse" },
  verified: { label: "Verified", cls: "text-ok border-ok/30 bg-ok/5", dot: "bg-ok" },
  unverified: { label: "Unverified", cls: "text-warn border-warn/30 bg-warn/5", dot: "bg-warn" },
  failed: { label: "Failed", cls: "text-bad border-bad/30 bg-bad/5", dot: "bg-bad" },
  cancelled: { label: "Cancelled", cls: "text-ink-muted border-line-strong", dot: "bg-ink-faint" },
  unknown: { label: "Unknown", cls: "text-warn border-warn/30", dot: "bg-warn" },
};

export default function StatusBadge({ status }: { status: RunStatus | "unknown" }) {
  const s = STYLES[status] ?? STYLES.queued;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-xs ${s.cls}`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
