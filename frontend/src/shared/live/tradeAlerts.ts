// Trade alerts (owner 26-Oct-2026: "I didn't know this trade happened"): a sound and a desktop pop-up when any paper
// strategy enters or exits. Pure part: compare two readings of today's trades (GET /api/journal/trades) and list what
// changed. The first reading only seeds what is known, so opening the app never replays old trades.

export interface AlertTrade {
  id: string;
  source: string; // 'auto' | 'manual' | 'excel'
  strategy: string;
  symbol: string;
  instrument: string | null;
  qty: number;
  entryPrice: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  netPnl: number | null;
  status: 'open' | 'closed';
}

export interface TradeEvent {
  kind: 'entry' | 'exit';
  title: string;
  body: string;
}

const money = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const idx = (s: string) => (s === 'BANKNIFTY' ? 'Bank Nifty' : 'Nifty');

/** known: trade id -> status from the last reading (null = first reading). Returns the events and the new map. */
export function diffTrades(known: Map<string, string> | null, trades: AlertTrade[]): { events: TradeEvent[]; known: Map<string, string> } {
  const next = new Map<string, string>();
  const events: TradeEvent[] = [];
  for (const t of trades) {
    if (t.source === 'excel') continue;
    next.set(t.id, t.status);
    if (!known) continue;
    const was = known.get(t.id);
    if (was === undefined) {
      events.push({ kind: 'entry', title: `${t.strategy} · ${idx(t.symbol)} · bought`,
        body: `${t.instrument ?? ''} · ${t.qty} qty at ${t.entryPrice ?? '–'}` });
    }
    if (t.status === 'closed' && was !== 'closed') {
      events.push({ kind: 'exit', title: `${t.strategy} · ${idx(t.symbol)} · exited${t.exitReason ? ` (${t.exitReason})` : ''}`,
        body: `${t.instrument ?? ''} · sold at ${t.exitPrice ?? '–'} · net ${t.netPnl == null ? '–' : money(t.netPnl)}` });
    }
  }
  return { events, known: next };
}
