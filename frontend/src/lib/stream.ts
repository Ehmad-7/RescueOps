// SSE client for GET /runs/{id}/events with replay-safe reconnection.
//
// - Native EventSource. While it is CONNECTING after a drop it retries by itself and sends
//   Last-Event-ID, which the backend uses to resume (no duplicates).
// - If the EventSource gives up (readyState CLOSED: HTTP error, backend restart, CORS), we
//   reconnect manually with `?after=<lastSeq>` and exponential backoff, up to `maxRetries`.
// - Events are deduplicated by seq here as well (seq <= lastSeq dropped).
// - On a terminal event the connection is closed for good: the server ends the stream after
//   it, and a native EventSource would otherwise reconnect forever.

import { EVENT_TYPES, TERMINAL_TYPES, parseEvent, type AgentEvent } from "./events.ts";

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

/** The subset of EventSource used here (so tests can supply a fake). */
export interface EventSourceLike {
  readonly readyState: number; // 0 CONNECTING, 1 OPEN, 2 CLOSED
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: string, listener: (ev: { data: string; lastEventId?: string }) => void): void;
  close(): void;
}

export interface StreamOptions {
  url: (after: number) => string;
  createSource: (url: string) => EventSourceLike;
  onEvent: (ev: AgentEvent) => void;
  onState: (state: ConnectionState) => void;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const CLOSED = 2;

export class RunEventStream {
  private opts: Required<StreamOptions>;
  private source: EventSourceLike | null = null;
  private timer: unknown = null;
  private retries = 0;
  private stopped = false;
  private lastSeqValue = -1;
  private terminalSeen = false;
  private stateValue: ConnectionState = "idle";

  constructor(opts: StreamOptions) {
    this.opts = {
      maxRetries: 6,
      baseDelayMs: 1000,
      maxDelayMs: 15000,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...opts,
    };
  }

  get lastSeq(): number {
    return this.lastSeqValue;
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  get terminal(): boolean {
    return this.terminalSeen;
  }

  start(): void {
    this.stopped = false;
    this.connect("connecting");
  }

  /** Close permanently (unmount, run lost). */
  stop(): void {
    this.stopped = true;
    this.clearPending();
    this.closeSource();
  }

  /** Manual reconnect after the retry budget was exhausted. */
  retry(): void {
    if (this.terminalSeen) return;
    this.stopped = false;
    this.retries = 0;
    this.clearPending();
    this.connect("connecting");
  }

  private setState(s: ConnectionState): void {
    if (s !== this.stateValue) {
      this.stateValue = s;
      this.opts.onState(s);
    }
  }

  private connect(state: ConnectionState): void {
    this.closeSource();
    this.setState(state);
    const src = this.opts.createSource(this.opts.url(this.lastSeqValue));
    this.source = src;
    src.onopen = () => {
      if (this.source !== src) return;
      this.retries = 0;
      this.setState("open");
    };
    src.onerror = () => {
      if (this.source !== src || this.stopped || this.terminalSeen) return;
      if (src.readyState === CLOSED) {
        this.closeSource();
        this.scheduleReconnect();
      } else {
        this.setState("reconnecting"); // native retry with Last-Event-ID is in progress
      }
    };
    const handler = (msg: { data: string }) => {
      if (this.source !== src) return;
      const ev = parseEvent(msg.data);
      if (!ev || ev.seq <= this.lastSeqValue) return;
      this.lastSeqValue = ev.seq;
      this.opts.onEvent(ev);
      if (TERMINAL_TYPES.has(ev.type)) {
        this.terminalSeen = true;
        this.closeSource();
        this.setState("closed");
      }
    };
    for (const t of EVENT_TYPES) src.addEventListener(t, handler);
  }

  private scheduleReconnect(): void {
    if (this.retries >= this.opts.maxRetries) {
      this.setState("error");
      return;
    }
    const delay = Math.min(this.opts.baseDelayMs * 2 ** this.retries, this.opts.maxDelayMs);
    this.retries += 1;
    this.setState("reconnecting");
    this.timer = this.opts.setTimer(() => {
      this.timer = null;
      if (!this.stopped && !this.terminalSeen) this.connect("reconnecting");
    }, delay);
  }

  private clearPending(): void {
    if (this.timer !== null) {
      this.opts.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private closeSource(): void {
    if (this.source) {
      const s = this.source;
      this.source = null;
      s.onopen = null;
      s.onerror = null;
      s.close();
    }
  }
}
