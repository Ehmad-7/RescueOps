"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { runningTools, type TimelineState } from "@/lib/events";
import type { ConnectionState } from "@/lib/stream";
import { toolLabel } from "@/lib/tools";
import { IconAlert, IconArrowDown, IconPulse, IconRefresh, Spinner } from "../ui/icons";
import { Button, Dot, Panel, streamState } from "../ui/primitives";
import LogRow from "./LogRow";

const NEAR_BOTTOM_PX = 48;

interface Props {
  timeline: TimelineState;
  connection: ConnectionState;
  lost: boolean;
  onRetry: () => void;
}

export default function ExecutionLog({ timeline, connection, lost, onRetry }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [seenCount, setSeenCount] = useState(0);
  const items = timeline.items;
  const start = items[0]?.ts ?? 0;
  const running = runningTools(timeline);
  const unseen = atBottom ? 0 : Math.max(0, items.length - seenCount);
  const showRetry = !lost && connection === "error" && !timeline.terminal;
  const [tone, label] = streamState(connection, lost);

  // Follow new events only while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [timeline.lastSeq, atBottom]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (near !== atBottom) {
      setAtBottom(near);
      if (!near) setSeenCount(items.length);
    }
  }

  function jumpToLatest() {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  return (
    <Panel
      title="Execution log"
      icon={<IconPulse size={14} />}
      labelledBy="log-title"
      bodyClassName=""
      actions={
        <>
          <span className="font-mono text-xs text-ink-faint tabular-nums">{timeline.eventCount} events</span>
          {showRetry && (
            <Button size="sm" variant="ghost" icon={<IconRefresh size={12} />} onClick={onRetry}>
              Reconnect
            </Button>
          )}
          <span role="status" className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
            <Dot tone={tone} pulse={connection === "reconnecting" && !lost} />
            <span className="sr-only">Event stream: </span>
            {label}
          </span>
        </>
      }
    >
      {running.length > 0 && (
        <p className="flex items-center gap-2 border-b border-line bg-accent/[0.05] px-4 py-2 text-[13px] text-accent-strong">
          <Spinner size={12} />
          <span className="truncate">Executing {running.map((t) => toolLabel(t).toLowerCase()).join(", ")}</span>
        </p>
      )}

      <div className="relative">
        <div
          ref={scroller}
          onScroll={onScroll}
          tabIndex={0}
          aria-label="Agent activity log"
          className="max-h-[70vh] overflow-y-auto focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none focus-visible:ring-inset xl:max-h-[min(46rem,calc(100vh-15rem))]"
        >
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
              {connection === "error" || lost ? (
                <>
                  <IconAlert size={18} className="text-bad" />
                  <p className="text-[13px] text-ink-muted">Could not connect to the event stream.</p>
                </>
              ) : (
                <>
                  <Spinner size={16} className="text-accent" />
                  <p className="text-[13px] text-ink-muted">Preparing sandbox and connecting tools…</p>
                </>
              )}
            </div>
          ) : (
            <ol role="log" aria-live="polite" aria-relevant="additions">
              {items.map((it) => (
                <LogRow key={it.seq} item={it} start={start} />
              ))}
            </ol>
          )}
        </div>

        {unseen > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-raised px-3 text-[13px] text-ink shadow-lg shadow-black/50 transition-colors hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none"
          >
            <IconArrowDown size={13} /> {unseen} new
          </button>
        )}
      </div>

      {(connection === "reconnecting" || showRetry || lost) && (
        <p role="status" className="flex items-center gap-2 border-t border-line bg-warn/[0.05] px-4 py-2 text-[13px] text-warn">
          <IconAlert size={13} className="shrink-0" />
          {lost
            ? "The backend no longer has this run; live updates stopped."
            : showRetry
              ? "Live updates disconnected. Status keeps refreshing; reconnect to resume the log."
              : "Connection dropped. Resuming from the last received event…"}
        </p>
      )}
    </Panel>
  );
}
