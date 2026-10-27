// src/apps/paper-trade/logic/feed.ts
// WebSocket client for /ws/paper: reconnects with backoff, re-sends subscriptions after every reconnect, and
// coalesces ticks so each instrument updates the UI at most once per TICK_FLUSH_MS (about 4 times a second).
import { WS_LOGIN_CLOSE, signalLoggedOut } from '../../../shared/api';
import { RECONNECT_DELAYS_MS, TICK_FLUSH_MS } from '../config/settings';
import type { Funds, Meta, Order, Position, Tick, Trade } from './api';

export type InstrumentKey = `${string}:${number}`; // "NSE_FNO:52175", "IDX_I:13"
export const keyOf = (segment: string, securityId: number): InstrumentKey => `${segment}:${securityId}`;

export type ServerMessage =
  | { type: 'snapshot'; meta: Meta; funds: Funds; positions: Position[]; orders: Order[] }
  | { type: 'status'; data: Meta }
  | { type: 'funds'; data: Funds }
  | { type: 'order'; data: Order }
  | { type: 'trade'; data: Trade }
  | { type: 'position'; data: Position }
  | { type: 'tick'; data: Tick }
  | { type: 'candle'; data: LiveCandle } // current 1-minute candle of a subscribed index (Dashboard chart)
  | { type: 'volume'; data: { segment: string; securityId: number; time: number; volume: number } } // index future, this minute
  | { type: 'error'; data: { message: string } };

export interface LiveCandle {
  segment: string;
  securityId: number;
  interval: 1;
  time: number; // epoch seconds of the minute start
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ConnState = 'connecting' | 'open' | 'reconnecting';

export const reconnectDelay = (attempt: number, delays = RECONNECT_DELAYS_MS) => delays[Math.min(attempt, delays.length - 1)];

/** Keeps the newest tick per instrument and hands them out at most every `intervalMs`. */
export class TickBuffer {
  private pending = new Map<InstrumentKey, Tick>();
  private lastFlush = -Infinity;

  constructor(private intervalMs = TICK_FLUSH_MS) {}

  put(t: Tick) {
    this.pending.set(keyOf(t.segment, t.securityId), t);
  }

  /** Returns the ticks to apply now (empty if it is too soon or nothing changed). */
  drain(now: number): Map<InstrumentKey, Tick> {
    if (!this.pending.size || now - this.lastFlush < this.intervalMs) return new Map();
    this.lastFlush = now;
    const out = this.pending;
    this.pending = new Map();
    return out;
  }
}

type Socket = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
};

export interface FeedHandlers {
  onMessage: (m: Exclude<ServerMessage, { type: 'tick' }>) => void;
  onTicks: (ticks: Map<InstrumentKey, Tick>) => void;
  onState: (s: ConnState) => void;
}

export class PaperFeed {
  private ws: Socket | null = null;
  private subs = new Set<InstrumentKey>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;
  private closed = false;
  private buffer = new TickBuffer();

  constructor(
    private url: string,
    private h: FeedHandlers,
    private makeSocket: (url: string) => Socket = (u) => new WebSocket(u) as Socket,
    private schedule: (fn: () => void) => number = (fn) => requestAnimationFrame(fn),
  ) {}

  connect() {
    this.closed = false;
    this.h.onState(this.attempt ? 'reconnecting' : 'connecting');
    const ws = this.makeSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.h.onState('open');
      this.sendSubs('subscribe', [...this.subs]);
    };
    ws.onmessage = (ev) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === 'tick') {
        this.buffer.put(m.data);
        this.pump();
      } else {
        this.h.onMessage(m);
      }
    };
    ws.onclose = (ev) => {
      this.ws = null;
      if (ev?.code === WS_LOGIN_CLOSE) {
        this.closed = true; // session gone: the app shows the login page; no reconnect loop
        signalLoggedOut();
      }
      if (this.closed) return;
      this.h.onState('reconnecting');
      this.timer = setTimeout(() => this.connect(), reconnectDelay(this.attempt++));
    };
    ws.onerror = () => ws.close();
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  /** Replace the set of instruments this page wants ticks for. */
  setSubscriptions(keys: InstrumentKey[]) {
    const next = new Set(keys);
    const add = keys.filter((k) => !this.subs.has(k));
    const drop = [...this.subs].filter((k) => !next.has(k));
    this.subs = next;
    if (add.length) this.sendSubs('subscribe', add);
    if (drop.length) this.sendSubs('unsubscribe', drop);
  }

  private sendSubs(type: 'subscribe' | 'unsubscribe', keys: InstrumentKey[]) {
    if (!keys.length || !this.ws || this.ws.readyState !== 1) return;
    const instruments = keys.map((k) => {
      const i = k.lastIndexOf(':');
      return [k.slice(0, i), Number(k.slice(i + 1))];
    });
    this.ws.send(JSON.stringify({ type, instruments }));
  }

  private pump() {
    if (this.frame) return;
    this.frame = this.schedule(() => {
      this.frame = 0;
      const ticks = this.buffer.drain(performance.now());
      if (ticks.size) this.h.onTicks(ticks);
      else setTimeout(() => this.pump(), TICK_FLUSH_MS); // too soon: try again after the interval
    });
  }
}
