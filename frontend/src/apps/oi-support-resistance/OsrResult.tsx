// Result screen of OI Support & Resistance, shared by the paste app and the live (Dhan) app.
// Moved out of OiSupportResistanceApp unchanged; only the words that mention pasting depend on `source`.
import { useState } from 'react';
import { copyText } from '../../shared/clipboard';
import { inr, signed } from '../../shared/grid';
import { Alert, EmptyState, Pill, Stat } from '../../shared/ui';
import {
  TREND_LABEL, compareOi, lakh, levelTrend, levelsText, oiTone, trendTone, zoneOi,
  type Analysis, type Change, type Level, type LevelView, type Side, type StrikeOi,
} from './logic/levels';

/** Paste time in IST, "11:05". */
export const hm = (t: number) =>
  new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const toneClass = (t: string) => (t === 'neutral' ? '' : t);
const SIDE_NAME: Record<Side, string> = { R: 'Resistance (call OI)', S: 'Support (put OI)' };

function LevelTable({ side, levels, chg, spot, chgTitle }: { side: Side; levels: Level[]; chg: StrikeOi; spot: number; chgTitle: string }) {
  if (!levels.length) return <EmptyState>No strikes in this range. Widen the range in Settings.</EmptyState>;
  const i = side === 'R' ? 0 : 1;
  return (
    <table className="t">
      <thead>
        <tr><th>Level</th><th>Strike</th><th>OI</th><th title={chgTitle}>Chg OI</th><th>From spot</th></tr>
      </thead>
      <tbody>
        {levels.map((x, k) => {
          const c = chg[x.strike]?.[i] ?? 0;
          const d = Math.round(x.strike - spot);
          return (
            <tr key={x.strike}>
              <td><Pill tone={side === 'R' ? 'down' : 'up'}>{side}{k + 1}</Pill></td>
              <td>{inr(0)(x.strike)}</td>
              <td>{inr(0)(x.oi)}</td>
              <td className={toneClass(oiTone(side, c))}>{signed(0)(c)}</td>
              <td>{inr(0)(Math.abs(d))} pts {x.strike >= spot ? 'above' : 'below'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ChangeCell({ change, side }: { change: Change | null; side: Side }) {
  if (!change) return <td>–</td>;
  if (change.pct == null || !change.trend) return <td>{inr(0)(change.was)}</td>;
  return (
    <td>
      <span className="osr-was">was {inr(0)(change.was)}</span>
      <Pill tone={trendTone(side, change.trend)}>{signed(2)(change.pct)}% {TREND_LABEL[change.trend]}</Pill>
    </td>
  );
}

const WORDS = {
  paste: {
    one: 'paste', many: 'pastes', again: 'Paste again', data: 'the data you paste',
    chgTitle: 'NSE change in OI since the previous day',
  },
  live: {
    one: 'refresh', many: 'refreshes', again: 'Refresh again', data: 'the Dhan data you refresh',
    chgTitle: "Dhan OI minus Dhan's previous-day settled OI",
  },
} as const;

export function OsrResult({ result, view, range, threshold, source }: {
  result: Analysis;
  view: LevelView;
  range: number;
  threshold: number;
  source: 'paste' | 'live';
}) {
  const words = WORDS[source];
  const [copied, setCopied] = useState('');

  const copyLevels = async () => {
    const text = levelsText(view.cur, hm(view.cur.t), view.levels);
    setCopied((await copyText(text)) ? 'Copied' : `Copy failed. Select this text manually: ${text}`);
    setTimeout(() => setCopied(''), 2500);
  };

  return (
        <>
          <section>
            <div className="osr-asof">
              {view.cur.symbol} · Expiry {view.cur.expiry} · As of {view.cur.nse || hm(view.cur.t)} IST
            </div>
            <div className="stats">
              <Stat label="Spot" value={inr(2)(view.cur.spot)} />
              <Stat label="PCR (OI)" value={result.pcr != null ? inr(2)(result.pcr) : '–'} />
              <Stat label="Max pain" value={result.maxPain != null ? inr(0)(result.maxPain) : '–'} />
              <Stat label="Days to expiry" value={result.daysToExpiry ?? '–'} />
            </div>
          </section>

          <div className="osr-zones">
            {(['R', 'S'] as const).map((side) => (
              <section key={side} className={`card ${side === 'R' ? 'osr-res' : 'osr-sup'}`}>
                <div className="card-head">
                  <h3 className="card-title">{side === 'R' ? 'Resistance · call OI above spot' : 'Support · put OI below spot'}</h3>
                  <span className="muted">Top {view.levels[side].length} within {inr(0)(range)} pts</span>
                </div>
                <div className="osr-scroll">
                  <LevelTable side={side} levels={view.levels[side]} chg={result.chg} spot={view.cur.spot} chgTitle={words.chgTitle} />
                </div>
              </section>
            ))}
          </div>

          <section className="card osr-line">
            <p>
              {view.levels.R[0] && view.levels.S[0] ? (
                <>
                  Spot is <b>{inr(0)(Math.round(view.cur.spot - view.levels.S[0].strike))} pts above</b> S1 ({inr(0)(view.levels.S[0].strike)}) and{' '}
                  <b>{inr(0)(Math.round(view.levels.R[0].strike - view.cur.spot))} pts below</b> R1 ({inr(0)(view.levels.R[0].strike)}).
                </>
              ) : 'Not enough strikes on both sides of spot in this range.'}
            </p>
            <span className="toolbar-end">
              {copied && <span className="muted">{copied}</span>}
              <button className="btn" onClick={copyLevels}>Copy levels for chart</button>
            </span>
          </section>

          <section className="card">
            <div className="card-head"><h3 className="card-title">Change since your earlier {words.many}</h3></div>
            {!view.base || !view.prev ? (
              <EmptyState>This is your baseline ({hm(view.cur.t)} IST). {words.again} later to see how OI changed at each level.</EmptyState>
            ) : (
              <>
                {view.shifts.length > 0 && (
                  <div className="osr-stack">
                    {view.shifts.map((s) => (
                      <Alert key={`${s.level}-${s.since}`} kind="info">
                        {s.level} moved from {inr(0)(s.from)} to {inr(0)(s.to)} (since {s.since === 'baseline' ? 'baseline' : `your previous ${words.one}`}).
                      </Alert>
                    ))}
                  </div>
                )}
                <div className="osr-scroll">
                  <table className="t osr-cmp">
                    <thead>
                      <tr>
                        <th>Strike</th><th>OI now</th><th>vs baseline ({hm(view.base.t)})</th><th>vs previous ({hm(view.prev.t)})</th>
                        <th title="OI of the strike plus one strike either side">Zone (±1 strike) vs baseline</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(['R', 'S'] as const).flatMap((side) => {
                        const i = side === 'R' ? 0 : 1;
                        const base = view.base!;
                        const prev = view.prev!;
                        if (!view.levels[side].length) return [];
                        return [
                          <tr key={side} className="osr-group"><td colSpan={5}>{SIDE_NAME[side]}</td></tr>,
                          ...view.levels[side].map((x) => (
                            <tr key={`${side}-${x.strike}`}>
                              <td>{inr(0)(x.strike)}</td>
                              <td>{inr(0)(x.oi)}</td>
                              <ChangeCell side={side} change={compareOi(base.rows[x.strike]?.[i], x.oi, threshold)} />
                              <ChangeCell side={side} change={compareOi(prev.rows[x.strike]?.[i], x.oi, threshold)} />
                              <ChangeCell
                                side={side}
                                change={base.rows[x.strike]
                                  ? compareOi(zoneOi(base.rows, x.strike, side, view.step), zoneOi(view.cur.rows, x.strike, side, view.step), threshold)
                                  : null}
                              />
                            </tr>
                          )),
                        ];
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <p className="card-foot">
              Seller's view: rising put OI at support is green (support holding), falling put OI is red (support weakening).
              Rising call OI at resistance is red (sellers defending), falling call OI is green (resistance weakening).
              ±{threshold}% or more counts as a change. OI is a filter: confirm with a candle close beyond the level on your chart.
            </p>
          </section>

          <section className="card">
            <div className="card-head"><h3 className="card-title">Level trend through the day</h3><span className="muted">OI in lakh contracts</span></div>
            <div className="osr-scroll">
              <table className="t">
                <thead>
                  <tr><th>Level</th>{view.timeline.map((sn) => <th key={sn.t}>{hm(sn.t)}</th>)}</tr>
                </thead>
                <tbody>
                  {(['R', 'S'] as const).flatMap((side) => {
                    const cells = levelTrend(view.levels[side], side, view.timeline);
                    if (!cells.length) return [];
                    return [
                      <tr key={side} className="osr-group"><td colSpan={view.timeline.length + 1}>{SIDE_NAME[side]}</td></tr>,
                      ...view.levels[side].map((x, k) => (
                        <tr key={`${side}-${x.strike}`}>
                          <td><Pill tone={side === 'R' ? 'down' : 'up'}>{side}{k + 1}</Pill> {inr(0)(x.strike)}</td>
                          {cells[k].map((c, j) => (
                            <td key={j}>
                              {c.oi == null ? '–' : lakh(c.oi)}
                              {c.direction !== 0 && <span className={toneClass(oiTone(side, c.direction))}> {c.direction > 0 ? '▲' : '▼'}</span>}
                            </td>
                          ))}
                        </tr>
                      )),
                    ];
                  })}
                </tbody>
              </table>
            </div>
            <p className="card-foot">
              Levels come from open interest in {words.data}. They show where positions are, not a forecast. Options carry substantial risk.
            </p>
          </section>
        </>
  );
}
