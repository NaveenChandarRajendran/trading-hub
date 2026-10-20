import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api';
import { inr } from '../../shared/grid';
import { Alert, EmptyState, Heatmap, Stat } from '../../shared/ui';
import { downloadCsv, hms, price, rupees, shortName, signedRupees, toneOf } from './format';
import { api, type PnlResponse, type Trade } from './logic/api';
import { buildCalendar, dayLabel, fyLabel, fyOf, fyRange } from './logic/calendar';
import { byMonth, summarize, toCsv } from './logic/pnl';
import type { Paper } from './usePaper';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (m: string) => `${MONTH_NAMES[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;

export function PnlView({ paper }: { paper: Paper }) {
  const today = paper.today;
  const current = fyOf(today);
  const [fy, setFy] = useState(current);
  const [data, setData] = useState<PnlResponse | null>(null);
  const [error, setError] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [dayTrades, setDayTrades] = useState<Trade[] | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const { from, to } = fyRange(fy);
    api.pnl(from, to, ctrl.signal)
      .then((r) => {
        setData(r);
        setError('');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load the P&L report.');
      });
    return () => ctrl.abort();
  }, [fy, paper.tradeVersion, paper.meta?.accountId]);

  useEffect(() => {
    if (!day) return;
    const ctrl = new AbortController();
    setDayTrades(null);
    api.trades(day, ctrl.signal).then((r) => setDayTrades(r.rows)).catch(() => setDayTrades([]));
    return () => ctrl.abort();
  }, [day, paper.tradeVersion]);

  const rows = data?.rows ?? [];
  const s = useMemo(() => summarize(rows), [rows]);
  const months = useMemo(() => byMonth(rows), [rows]);
  const cal = useMemo(() => {
    const { from, to } = fyRange(fy);
    return buildCalendar(from, to, rows, data?.meta.holidays ?? [], today);
  }, [fy, rows, data, today]);
  const selected = day ? rows.find((r) => r.date === day) : undefined;

  return (
    <>
      <section className="card">
        <div className="toolbar">
          <label className="field">Financial year
            <select value={fy} onChange={(e) => { setFy(Number(e.target.value)); setDay(null); }}>
              {[current, current - 1, current - 2].map((y) => <option key={y} value={y}>{fyLabel(y)}</option>)}
            </select>
          </label>
          <span className="muted">Net = realized P&amp;L − charges, by IST trade date. Current account only.</span>
        </div>
        {error && <div className="pt-gap"><Alert kind="error">{error}</Alert></div>}
      </section>

      {!data && !error ? <p className="muted">Loading…</p> : (
        <>
          <div className="stats">
            <Stat label="Net P&L" value={<span className={toneOf(s.net)}>{signedRupees(s.net)}</span>} delta={`${s.trades} fills · ${s.days} days`} />
            <Stat label="Charges" value={rupees(s.charges)} delta={`Realized ${signedRupees(s.realized)}`} />
            <Stat label="Win / loss days" value={`${s.winDays} / ${s.lossDays}`}
              delta={s.days ? `${inr(0)((s.winDays / s.days) * 100)}% winning days` : 'No trading days yet'} />
            <Stat label="Best day" value={<span className="up">{s.best ? signedRupees(s.best.net) : '–'}</span>} delta={s.best ? dayLabel(s.best.date) : ''} />
            <Stat label="Worst day" value={<span className="down">{s.worst ? signedRupees(s.worst.net) : '–'}</span>} delta={s.worst ? dayLabel(s.worst.date) : ''} />
          </div>

          <section className="card">
            <div className="card-head">
              <h3 className="card-title">Daily P&amp;L · {fyLabel(fy)}</h3>
              <button className="btn ghost" disabled={!rows.length}
                onClick={() => downloadCsv(`paper-pnl-${fyLabel(fy).replace(/\s/g, '')}.csv`, toCsv(rows))}>CSV</button>
            </div>
            <Heatmap weeks={cal.weeks} months={cal.months} selected={day ?? undefined} onSelect={setDay} />
            {!rows.length && <p className="card-foot">No trades yet in {fyLabel(fy)}. Days fill in green or red as you trade.</p>}
          </section>

          <div className="split pt-split-even">
            <section className="card">
              <div className="card-head"><h3 className="card-title">By month</h3></div>
              {!months.length ? <EmptyState>No trades yet.</EmptyState> : (
                <table className="t">
                  <thead><tr><th>Month</th><th>Net</th><th>Charges</th><th>Fills</th><th>Win / loss days</th></tr></thead>
                  <tbody>
                    {months.map((m) => (
                      <tr key={m.month}>
                        <td>{monthName(m.month)}</td>
                        <td className={toneOf(m.net)}>{signedRupees(m.net)}</td>
                        <td>{rupees(m.charges)}</td>
                        <td>{m.trades}</td>
                        <td>{m.winDays} / {m.lossDays}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h3 className="card-title">{day ? dayLabel(day) : 'Day trades'}</h3>
                {selected && <span className={`num ${toneOf(selected.net)}`}>{signedRupees(selected.net)} net · charges {rupees(selected.charges)}</span>}
              </div>
              {!day ? <EmptyState>Click a day in the calendar to see its trades.</EmptyState>
                : dayTrades == null ? <p className="muted">Loading…</p>
                : !dayTrades.length ? <EmptyState>No trades on this day.</EmptyState> : (
                  <div className="pt-scroll">
                    <table className="t">
                      <thead><tr><th>Time</th><th>Instrument</th><th>Side</th><th>Qty</th><th>Price</th><th>Charges</th></tr></thead>
                      <tbody>
                        {dayTrades.map((t) => (
                          <tr key={t.id}>
                            <td>{hms(t.time)}</td>
                            <td title={t.name}>{shortName(t)}</td>
                            <td><span className={`pt-side ${t.side === 'BUY' ? 'buy' : 'sell'}`}>{t.side}</span></td>
                            <td>{t.qty}</td>
                            <td>{price(t.price)}</td>
                            <td>{rupees(t.charges.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
