"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { API_URL } from "./api";
import { EMPTY_TIMELINE, TERMINAL_TYPES, applyEvent, type AgentEvent, type TimelineState } from "./events";
import { RunEventStream, type ConnectionState } from "./stream";

// State is keyed by run id, so events/connection changes of a previous run can never leak
// into the next one and no reset effect is needed.
interface Keyed {
  runId: string | null;
  timeline: TimelineState;
  connection: ConnectionState;
}

type Action =
  | { type: "event"; runId: string; ev: AgentEvent }
  | { type: "connection"; runId: string; state: ConnectionState };

function reducer(s: Keyed, a: Action): Keyed {
  const cur = s.runId === a.runId ? s : { runId: a.runId, timeline: EMPTY_TIMELINE, connection: "idle" as const };
  if (a.type === "event") {
    const timeline = applyEvent(cur.timeline, a.ev);
    return timeline === cur.timeline && cur === s ? s : { ...cur, timeline };
  }
  return a.state === cur.connection && cur === s ? s : { ...cur, connection: a.state };
}

const INITIAL: Keyed = { runId: null, timeline: EMPTY_TIMELINE, connection: "idle" };

/**
 * Live event timeline for one run. `enabled=false` stops the stream (e.g. run lost).
 * `onTerminal` fires when the terminal event arrives (used to refresh the authoritative summary).
 */
export function useRunEvents(runId: string | null, enabled: boolean, onTerminal?: () => void) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const streamRef = useRef<RunEventStream | null>(null);
  const onTerminalRef = useRef(onTerminal);

  useEffect(() => {
    onTerminalRef.current = onTerminal;
  }, [onTerminal]);

  useEffect(() => {
    if (!runId || !enabled || !API_URL) return;
    const stream = new RunEventStream({
      url: (after) => `${API_URL}/runs/${encodeURIComponent(runId)}/events${after >= 0 ? `?after=${after}` : ""}`,
      createSource: (url) => new EventSource(url),
      onEvent: (ev) => {
        dispatch({ type: "event", runId, ev });
        if (TERMINAL_TYPES.has(ev.type)) onTerminalRef.current?.();
      },
      onState: (s) => dispatch({ type: "connection", runId, state: s }),
    });
    streamRef.current = stream;
    stream.start();
    return () => {
      stream.stop();
      if (streamRef.current === stream) streamRef.current = null;
    };
  }, [runId, enabled]);

  const retry = useCallback(() => streamRef.current?.retry(), []);
  const mine = state.runId === runId;

  return {
    timeline: mine ? state.timeline : EMPTY_TIMELINE,
    connection: mine && runId ? state.connection : ("idle" as ConnectionState),
    retry,
  };
}
