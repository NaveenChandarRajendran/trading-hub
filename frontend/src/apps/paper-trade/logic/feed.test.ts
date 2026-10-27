// src/apps/paper-trade/logic/feed.test.ts
import { describe, expect, it, vi } from 'vitest';
import { PaperFeed, TickBuffer, keyOf, reconnectDelay } from './feed';

describe('TickBuffer', () => {
  it('keeps only the newest tick per instrument and flushes at most every interval', () => {
    const b = new TickBuffer(250);
    b.put({ segment: 'NSE_FNO', securityId: 1, ltp: 100 });
    b.put({ segment: 'NSE_FNO', securityId: 1, ltp: 101 });
    b.put({ segment: 'IDX_I', securityId: 13, ltp: 25100 });
    const first = b.drain(1000);
    expect([...first.values()].map((t) => t.ltp)).toEqual([101, 25100]);
    b.put({ segment: 'NSE_FNO', securityId: 1, ltp: 102 });
    expect(b.drain(1100).size).toBe(0); // too soon
    expect(b.drain(1250).get(keyOf('NSE_FNO', 1))?.ltp).toBe(102);
    expect(b.drain(2000).size).toBe(0); // nothing new
  });
});

describe('reconnectDelay', () => {
  it('backs off and then stays at the last delay', () => {
    expect([0, 1, 2, 3, 4, 9].map((a) => reconnectDelay(a, [1, 2, 5]))).toEqual([1, 2, 5, 5, 5, 5]);
  });
});

class FakeSocket {
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send(m: string) {
    this.sent.push(JSON.parse(m));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
}

describe('PaperFeed', () => {
  it('stops reconnecting and signals "logged out" when the server closes with 4401', () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    vi.stubGlobal('window', { dispatchEvent: (e: Event) => fired.push(e.type) });
    const sockets: FakeSocket[] = [];
    const feed = new PaperFeed('ws://x', { onMessage: () => {}, onTicks: () => {}, onState: () => {} },
      () => { const s = new FakeSocket(); sockets.push(s); return s; }, (fn) => { fn(); return 1; });
    feed.connect();
    sockets[0].onclose?.({ code: 4401 } as CloseEvent);
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
    expect(fired).toEqual(['th:logged-out']);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('re-subscribes after a reconnect and sends only changes while open', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const states: string[] = [];
    const feed = new PaperFeed('ws://x', { onMessage: () => {}, onTicks: () => {}, onState: (s) => states.push(s) },
      () => { const s = new FakeSocket(); sockets.push(s); return s; }, (fn) => { fn(); return 1; });
    feed.setSubscriptions(['NSE_FNO:1', 'IDX_I:13']);
    feed.connect();
    sockets[0].open();
    expect(sockets[0].sent).toEqual([{ type: 'subscribe', instruments: [['NSE_FNO', 1], ['IDX_I', 13]] }]);
    feed.setSubscriptions(['IDX_I:13', 'NSE_FNO:2']);
    expect(sockets[0].sent.slice(1)).toEqual([
      { type: 'subscribe', instruments: [['NSE_FNO', 2]] },
      { type: 'unsubscribe', instruments: [['NSE_FNO', 1]] },
    ]);
    sockets[0].close();
    vi.advanceTimersByTime(1000);
    sockets[1].open();
    expect(sockets[1].sent).toEqual([{ type: 'subscribe', instruments: [['IDX_I', 13], ['NSE_FNO', 2]] }]);
    expect(states).toEqual(['connecting', 'open', 'reconnecting', 'reconnecting', 'open']);
    feed.close();
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(2); // closed on purpose: no reconnect
    vi.useRealTimers();
  });

  it('passes events through and batches ticks', () => {
    const msgs: string[] = [];
    const ticks: number[] = [];
    let s!: FakeSocket;
    const feed = new PaperFeed('ws://x', {
      onMessage: (m) => msgs.push(m.type), onTicks: (t) => ticks.push(t.size), onState: () => {},
    }, () => (s = new FakeSocket()), (fn) => { fn(); return 1; });
    feed.connect();
    s.open();
    s.onmessage?.({ data: JSON.stringify({ type: 'funds', data: {} }) } as MessageEvent);
    s.onmessage?.({ data: JSON.stringify({ type: 'tick', data: { segment: 'NSE_FNO', securityId: 1, ltp: 1 } }) } as MessageEvent);
    s.onmessage?.({ data: 'not json' } as MessageEvent);
    expect(msgs).toEqual(['funds']);
    expect(ticks).toEqual([1]);
  });
});
