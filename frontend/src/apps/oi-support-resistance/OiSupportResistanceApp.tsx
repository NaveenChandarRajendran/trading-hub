import { useEffect, useMemo, useState } from 'react';
import { copyText } from '../../shared/clipboard';
import { inr, signed } from '../../shared/grid';
import { Alert, EmptyState, Pill, Stat } from '../../shared/ui';
import { SYMBOLS, buildOptionChainUrl, upcomingExpiries } from '../option-strategy/config/expiries';
import { ChainParseError, parseOptionChain, type OptionChain } from '../option-strategy/logic/optionChain';
import { DEFAULT_RANGE, DEFAULT_THRESHOLD } from './config/settings';
import {
  TREND_LABEL, analyzeChain, compareOi, lakh, levelShifts, levelTrend, levelsText, oiTone, strikeStep, topLevels,
  trendTone, zoneOi, type Analysis, type Change, type Level, type Side, type Snapshot, type StrikeOi,
} from './logic/levels';
import { checkPaste, dayKey } from './logic/snapshots';
import { store } from './storage';
import './oi-sr.css';

/** Paste time in IST, "11:05". */
const hm = (t: number) =>
  new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const toneClass = (t: string) => (t === 'neutral' ? '' : t);
const readNum = (k: string, fallback: number) => Number(store.get(k)) || fallback;
const SIDE_NAME: Record<Side, string> = { R: 'Resistance (call OI)', S: 'Support (put OI)' };

function LevelTable({ side, levels, chg, spot }: { side: Side; levels: Level[]; chg: StrikeOi; spot: number }) {
  if (!levels.length) return <EmptyState>No strikes in this range. Widen the range in Settings.</EmptyState>;
  const i = side === 'R' ? 0 : 1;
  return (
    <table className="t">
      <thead>
        <tr><th>Level</th><th>Strike</th><th>OI</th><th title="NSE change in OI since the previous day">Chg OI</th><th>From spot</th></tr>
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

export default function OiSupportResistanceApp() {
  const [symbol, setSymbol] = useState<string>(() => {
    const s = store.get('symbol');
    return SYMBOLS.some((x) => x.value === s) ? s! : SYMBOLS[0].value;
  });
  const expiries = useMemo(() => upcomingExpiries(symbol), [symbol]);
  const [expiryPick, setExpiryPick] = useState('');
  const expiry = expiries.includes(expiryPick) ? expiryPick : expiries[0] ?? '';
  const url = expiry ? buildOptionChainUrl(symbol, expiry) : '';
  useEffect(() => store.set('symbol', symbol), [symbol]);

  const [range, setRange] = useState(() => readNum('range', DEFAULT_RANGE));
  const [threshold, setThreshold] = useState(() => readNum('threshold', DEFAULT_THRESHOLD));
  const [showSettings, setShowSettings] = useState(false);

  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ kind: 'warn' | 'info'; text: string } | null>(null);
  const [result, setResult] = useState<Analysis | null>(null);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [copied, setCopied] = useState('');
  const [cleared, setCleared] = useState(0); // bumps after "Clear today's data" so the paste list re-reads storage

  // Pastes for the analysed chain, or for the index + expiry picked in the toolbar before any analysis.
  const todays = useMemo(
    () => (result ? snaps : store.loadSnapshots(dayKey(symbol, expiry))),
    [result, snaps, symbol, expiry, cleared],
  );

  const analyze = (text: string, save: boolean) => {
    setError('');
    setNotice(null);
    let chain: OptionChain;
    try {
      chain = parseOptionChain(text);
    } catch (e) {
      setError(e instanceof ChainParseError ? e.message : 'Something went wrong while reading the data.');
      return;
    }
    if (chain.underlying <= 0) return setError('Could not find the spot price (underlyingValue) in this JSON.');
    const a = analyzeChain(chain);
    if (!Object.keys(a.snapshot.rows).length) return setError('No strikes found near spot in this data.');
    store.set('last', text);

    const key = dayKey(chain.symbol, chain.expiry);
    let list = store.loadSnapshots(key);
    if (save) {
      const check = checkPaste(list, a.snapshot);
      if (!check.ok) return setNotice({ kind: 'warn', text: check.message });
      list = [...list, a.snapshot];
      store.saveSnapshots(key, list);
    } else {
      setNotice({ kind: 'info', text: 'Showing your last paste. It was not saved again.' });
    }
    setResult(a);
    setSnaps(list);
    if (SYMBOLS.some((s) => s.value === chain.symbol)) {
      setSymbol(chain.symbol);
      setExpiryPick(chain.expiry);
    }
  };

  const loadLast = () => {
    const last = store.get('last');
    if (!last) return setError('No saved paste found yet.');
    setRaw(last);
    analyze(last, false);
  };

  const clearAll = () => {
    if (!confirm("Clear today's option chain data (all pastes and the last paste)? Settings are kept. This cannot be undone.")) return;
    store.clearData();
    setRaw('');
    setResult(null);
    setSnaps([]);
    setError('');
    setNotice(null);
    setCleared((n) => n + 1);
  };

  const view = useMemo(() => {
    if (!result) return null;
    const cur = result.snapshot;
    const levels = { R: topLevels(cur.rows, cur.spot, 'R', range), S: topLevels(cur.rows, cur.spot, 'S', range) };
    const earlier = snaps.filter((s) => s.t !== cur.t);
    const base = earlier[0];
    const prev = earlier[earlier.length - 1];
    return {
      cur,
      levels,
      base,
      prev,
      shifts: base ? levelShifts(levels, base, prev, range) : [],
      step: strikeStep(cur.rows),
      timeline: snaps.length ? snaps : [cur],
    };
  }, [result, snaps, range]);

  const copyLevels = async () => {
    if (!view) return;
    const text = levelsText(view.cur, hm(view.cur.t), view.levels);
    setCopied((await copyText(text)) ? 'Copied' : `Copy failed. Select this text manually: ${text}`);
    setTimeout(() => setCopied(''), 2500);
  };

  const setSetting = (k: 'range' | 'threshold', v: number) => {
    if (!(v > 0)) return;
    store.set(k, String(v));
    (k === 'range' ? setRange : setThreshold)(v);
  };

  const last = todays[todays.length - 1];

  return (
    <div className="ds osr">
      <section className="card">
        <div className="toolbar">
          <label className="field">Index
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {SYMBOLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="field">Expiry
            <select value={expiry} onChange={(e) => setExpiryPick(e.target.value)}>
              {expiries.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label className="field osr-url">NSE link
            <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <button className="btn" onClick={() => void copyText(url)} disabled={!url}>Copy</button>
          <a className="btn" href={url} target="_blank" rel="noreferrer">Open</a>
          <div className="toolbar-end">
            <span className="status">
              <span className={`dot ${last ? 'live' : ''}`} />
              {last ? `${todays.length} paste${todays.length > 1 ? 's' : ''} today · last ${hm(last.t)} IST` : 'No pastes yet today'}
            </span>
            <div className="osr-settings">
              <button className="btn ghost" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>Settings</button>
              {showSettings && (
                <div className="card osr-pop">
                  <label className="field">Range around spot (points)
                    <input type="number" min={100} step={50} value={range} onChange={(e) => setSetting('range', Number(e.target.value))} />
                  </label>
                  <label className="field">Change threshold (%)
                    <input type="number" min={1} step={1} value={threshold} onChange={(e) => setSetting('threshold', Number(e.target.value))} />
                  </label>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3 className="card-title">Paste option chain</h3></div>
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paste the full JSON response from option-chain-v3 here…" spellCheck={false} />
        <div className="osr-actions">
          <button className="btn primary" onClick={() => analyze(raw, true)} disabled={!raw.trim()}>Analyze</button>
          <button className="btn" onClick={loadLast}>Load last paste</button>
          <button className="btn ghost" onClick={clearAll}>Clear today's data</button>
        </div>
        <div className="osr-stack">
          {error && <Alert kind="error">{error}</Alert>}
          {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
        </div>
        {todays.length > 0 && (
          <div className="osr-chips">
            <span className="muted">Today's pastes:</span>
            {todays.map((s, i) => (
              <Pill key={s.t} tone={i === 0 ? 'accent' : 'neutral'}>{hm(s.t)} · spot {inr(0)(s.spot)}{i === 0 ? ' (baseline)' : ''}</Pill>
            ))}
          </div>
        )}
        <details>
          <summary>Where do I get this JSON?</summary>
          <ol>
            <li>Pick the index and expiry above, then click Open (visit nseindia.com first if it shows an empty page).</li>
            <li>Select all of the page's JSON, copy it and paste it above.</li>
            <li>Click Analyze. Your first paste of the day is the baseline; repeat later to see how OI changed.</li>
          </ol>
        </details>
      </section>

      {!view || !result ? (
        <EmptyState>Paste the option chain and click Analyze. The first paste of the day becomes the baseline; later pastes are compared with it.</EmptyState>
      ) : (
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
                  <LevelTable side={side} levels={view.levels[side]} chg={result.chg} spot={view.cur.spot} />
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
            <div className="card-head"><h3 className="card-title">Change since your earlier pastes</h3></div>
            {!view.base || !view.prev ? (
              <EmptyState>This is your baseline ({hm(view.cur.t)} IST). Paste again later to see how OI changed at each level.</EmptyState>
            ) : (
              <>
                {view.shifts.length > 0 && (
                  <div className="osr-stack">
                    {view.shifts.map((s) => (
                      <Alert key={`${s.level}-${s.since}`} kind="info">
                        {s.level} moved from {inr(0)(s.from)} to {inr(0)(s.to)} (since {s.since === 'baseline' ? 'baseline' : 'your previous paste'}).
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
              Levels come from open interest in the data you paste. They show where positions are, not a forecast. Options carry substantial risk.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
