// Portfolios: every options strategy as a card (Total P&L = booked + unbooked), and for the one picked how it did
// month by month (by expiry month) and trade by trade (one index + expiry = one trade; open a row for its fills).
// Read-only, re-read every 15 s. Numbers: backend options_report.py.
import { Fragment, useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../shared/api';
import { inr } from '../../shared/grid';
import { Alert, EmptyState, Pill, Stat } from '../../shared/ui';
import { longDate, price, rupees, signedRupees, toneOf } from '../paper-trade/format';
import { optionsApi, type Portfolio, type StrategyReport } from './logic/api';
import { STATUS_LABEL, STATUS_TONE, dayTime, fillAction, monthLabel, winLoss } from './logic/report';

const REFRESH_MS = 15_000;
const PICK_KEY = 'builder.portfolio';
const pctText = (v: number | null) => (v == null ? '–' : `${v > 0 ? '+' : ''}${inr(2)(v)}%`);

function remembered(): number | null {
  try { return Number(localStorage.getItem(PICK_KEY)) || null; } catch { return null; }
}

export function PortfoliosView() {
  const [rows, setRows] = useState<Portfolio[] | null>(null);
  const [pick, setPick] = useState<number | null>(remembered);
  const [report, setReport] = useState<StrategyReport | null>(null);
  const [open, setOpen] = useState<string | null>(null); // the trade whose fills are shown
  const [error, setError] = useState('');

  const read = useCallback((signal?: AbortSignal) => {
    const fail = (e: Error) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Report unavailable.'); };
    optionsApi.portfolios(signal).then((r) => {
      setRows(r);
      setError('');
      setPick((p) => (p && r.some((x) => x.id === p) ? p : r[0]?.id ?? null));
    }).catch(fail);
    if (pick != null) optionsApi.report(pick, signal).then((r) => setReport(r)).catch(fail);
  }, [pick]);
  useEffect(() => {
    const ctrl = new AbortController();
    read(ctrl.signal);
    const t = setInterval(() => read(), REFRESH_MS);
    return () => { ctrl.abort(); clearInterval(t); };
  }, [read]);
  const choose = (id: number) => {
    setPick(id);
    setReport(null);
    setOpen(null);
    try { localStorage.setItem(PICK_KEY, String(id)); } catch { /* not remembered */ }
  };

  if (error && !rows) return <Alert kind="error">{error}</Alert>;
  if (!rows) return <p className="muted sb-small">Loading…</p>;
  if (!rows.length) return <EmptyState>No options strategy yet. Create one on the Strategies page (Kind: Options) or from Paper trade.</EmptyState>;
  const r = report?.strategy.id === pick ? report : null;
  const s = r?.summary;
  return (
    <>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="sb-pf-cards">
        {rows.map((p) => (
          <button key={p.id} type="button" className={`card sb-pf-card ${p.id === pick ? 'on' : ''}`} onClick={() => choose(p.id)}
            aria-pressed={p.id === pick}>
            <span className="sb-pf-name">{p.name}{p.archived && <> <Pill>archived</Pill></>}</span>
            <span className="muted sb-small">Total P&amp;L</span>
            <span className={`sb-pf-total num ${toneOf(p.summary.total)}`}>{signedRupees(p.summary.total)}</span>
            <span className="muted sb-small">
              {p.summary.trades} trade{p.summary.trades === 1 ? '' : 's'}{p.summary.open ? ` · ${p.summary.open} open` : ''} · {rupees(p.summary.capital, 0)}
            </span>
            <span className="sb-pf-foot">
              <span>Unbooked <b className={`num ${toneOf(p.summary.unbooked)}`}>{signedRupees(p.summary.unbooked)}</b></span>
              <span>Booked <b className={`num ${toneOf(p.summary.booked)}`}>{signedRupees(p.summary.booked)}</b></span>
            </span>
          </button>
        ))}
      </div>

      {!r || !s ? <p className="muted sb-small">Loading the report…</p> : (
        <>
          <div className="stats">
            <Stat label="Total P&L" value={<span className={toneOf(s.total)}>{signedRupees(s.total)}</span>} delta={`${pctText(s.returnPct)} of capital`} />
            <Stat label="Booked (after charges)" value={<span className={toneOf(s.booked)}>{signedRupees(s.booked)}</span>} delta={`charges ${rupees(s.charges)}`} />
            <Stat label="Unbooked (open legs)" value={<span className={toneOf(s.unbooked)}>{signedRupees(s.unbooked)}</span>}
              delta={s.open ? `${s.open} trade${s.open === 1 ? '' : 's'} open` : 'nothing open'} />
            <Stat label="Win rate" value={s.winPct == null ? '–' : `${inr(1)(s.winPct)}%`} delta={winLoss(s.wins, s.trades)} />
          </div>

          <section className="card">
            <div className="card-head"><span className="card-title">Month by month</span>
              <span className="muted sb-small">A trade counts in the month it expires. Win % from finished trades.</span></div>
            {!r.months.length ? <EmptyState>No trades in {r.strategy.name} yet. Paper trade a design into it.</EmptyState> : (
              <div className="sb-pf-scroll">
                <table className="t">
                  <thead><tr><th>Month</th><th>Trades</th><th>W / L</th><th>Win %</th><th>Net P&amp;L</th><th>Return</th><th>Best</th><th>Worst</th><th>Charges</th></tr></thead>
                  <tbody>
                    {r.months.map((m) => (
                      <tr key={m.month}>
                        <td>{monthLabel(m.month)}</td>
                        <td className="num">{m.trades}{m.open ? <span className="muted"> + {m.open} open</span> : null}</td>
                        <td className="num">{winLoss(m.wins, m.trades)}</td>
                        <td className="num">{m.winPct == null ? '–' : `${inr(1)(m.winPct)}%`}</td>
                        <td className={`num ${toneOf(m.net)}`}>{signedRupees(m.net)}</td>
                        <td className={`num ${toneOf(m.returnPct)}`}>{pctText(m.returnPct)}</td>
                        <td className={`num ${toneOf(m.best)}`}>{m.best == null ? '–' : signedRupees(m.best)}</td>
                        <td className={`num ${toneOf(m.worst)}`}>{m.worst == null ? '–' : signedRupees(m.worst)}</td>
                        <td className="num">{rupees(m.charges)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head"><span className="card-title">Trades</span>
              <span className="muted sb-small">One index + expiry = one trade. Click a row for its fills.</span></div>
            {!r.trades.length ? <EmptyState>No trades yet.</EmptyState> : (
              <div className="sb-pf-scroll">
                <table className="t">
                  <thead><tr><th>Expiry</th><th className="txt">Status</th><th>Entered</th><th>Closed</th><th>Legs</th><th>Credit</th><th>Booked</th><th>Unbooked</th><th>Net P&amp;L</th></tr></thead>
                  <tbody>
                    {r.trades.map((t) => {
                      const key = `${t.symbol}|${t.expiry}`;
                      return (
                        <Fragment key={key}>
                          <tr className="sb-pf-row" onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>
                            <td>{open === key ? '▾' : '▸'} {t.symbol} {longDate(t.expiry)}</td>
                            <td className="txt"><Pill tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Pill></td>
                            <td className="num">{dayTime(t.entered)}</td>
                            <td className="num">{dayTime(t.closedAt)}</td>
                            <td className="num">{t.legs}</td>
                            <td className={`num ${toneOf(t.credit)}`}>{signedRupees(t.credit)}</td>
                            <td className={`num ${toneOf(t.booked)}`}>{signedRupees(t.booked)}</td>
                            <td className={`num ${toneOf(t.unbooked)}`}>{t.status === 'open' ? signedRupees(t.unbooked) : '–'}</td>
                            <td className={`num ${toneOf(t.net)}`}><b>{signedRupees(t.net)}</b></td>
                          </tr>
                          {open === key && (
                            <tr className="sb-pf-fills"><td colSpan={9}>
                              <table className="t">
                                <thead><tr><th>Time</th><th className="txt">Fill</th><th className="txt">Leg</th><th>Qty</th><th>Price</th><th>Booked</th><th>Charges</th></tr></thead>
                                <tbody>
                                  {t.fills.map((f, i) => (
                                    <tr key={i}>
                                      <td className="num">{dayTime(f.time)}</td>
                                      <td className={`txt ${f.side === 'SELL' ? 'down' : 'up'}`}>{fillAction(f)}</td>
                                      <td className="txt">{inr(0)(f.strike)} {f.optionType}</td>
                                      <td className="num">{f.qty}</td>
                                      <td className="num">{f.kind === 'settle' && !f.price ? '0 (OTM)' : price(f.price)}</td>
                                      <td className={`num ${toneOf(f.realized)}`}>{f.kind === 'open' ? '–' : signedRupees(f.realized)}</td>
                                      <td className="num">{rupees(f.charges)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
