// Backtest page (owner 5-Nov-2026): only the strategies we paper trade, one simple card each with a growth chart, what it
// trades (Nifty / BankNifty / stocks), the capital, the 5-year result, the average a year and the worst fall.
// "Simple and user friendly ... so I can explain it to my wife". Numbers: config/paperResults.ts. PAPER ANALYSIS.
import { RESULTS, SECTION_NOTE, lakhText, summarize, type PaperResult } from './config/paperResults';
import './backtest.css';

const SECTIONS: PaperResult['section'][] = ['Option Buy', 'Option Sell', 'Futures', 'Stock books', 'Scalping'];
const W = 300;
const H = 110;

function Spark({ r }: { r: PaperResult }) {
  const s = summarize(r);
  const vals = s.points.map((p) => p.value);
  const base = r.kind === 'rupees' ? 0 : r.capital;
  const lo = Math.min(base, ...vals);
  const hi = Math.max(base, ...vals);
  const pad = (hi - lo) * 0.08 || 1;
  const y = (v: number) => H - ((v - lo + pad) / (hi - lo + 2 * pad)) * H;
  const x = (i: number) => (i / (vals.length - 1)) * W;
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const yb = y(base);
  const area = `${line} L${W},${yb.toFixed(1)} L0,${yb.toFixed(1)} Z`;
  return (
    <div>
      <svg className="bt-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`${r.name}: ${s.points.map((p) => `${p.year} ${r.kind === 'rupees' ? lakhText(p.value, true) : lakhText(p.value)}`).join(', ')}`}>
        <defs>
          <clipPath id={`a-${r.id}`}><rect x="0" y="0" width={W} height={Math.max(0, yb)} /></clipPath>
          <clipPath id={`b-${r.id}`}><rect x="0" y={yb} width={W} height={Math.max(0, H - yb)} /></clipPath>
        </defs>
        <path d={area} className="up" clipPath={`url(#a-${r.id})`} />
        <path d={area} className="dn" clipPath={`url(#b-${r.id})`} />
        <line x1="0" x2={W} y1={yb} y2={yb} className="base" />
        <path d={line} className="ln" />
      </svg>
      <div className="bt-years">
        {s.points.map((p, i) => <span key={p.year}>{i === 0 ? 'Start' : `’${p.year.slice(2)}`}</span>)}
      </div>
    </div>
  );
}

function Card({ r }: { r: PaperResult }) {
  const s = summarize(r);
  const tone = s.total >= 0 ? 'up' : 'down';
  const cls = r.verdict === 'lost' ? 'lost' : r.verdict === 'ending' ? 'ending' : '';
  return (
    <article className={`bt-card ${cls}`}>
      <div className="bt-card-top">
        <span className="bt-index">{r.index}</span>
        <span className={`bt-verdict ${cls}`}>{r.verdictText}</span>
      </div>
      <h3 className="bt-name">{r.name}</h3>
      <p className="bt-what">{r.what}</p>
      <Spark r={r} />
      <div className="bt-figs">
        <div className="bt-fig"><span className="bt-label">Money kept for it</span><b>{lakhText(r.capital)}</b></div>
        {r.kind === 'rupees' ? (
          <div className="bt-fig"><span className="bt-label">Made in 5 years</span><b className={tone}>{lakhText(s.total, true)}</b></div>
        ) : (
          <div className="bt-fig"><span className="bt-label">₹5L grew to</span><b className={tone}>{lakhText(s.end)}</b></div>
        )}
        <div className="bt-fig">
          <span className="bt-label">Average a year</span>
          {r.kind === 'rupees'
            ? <b className={tone}>{lakhText(s.perYear, true)}</b>
            : <b className={tone}>{s.perYearPct > 0 ? '+' : ''}{s.perYearPct}%</b>}
          <span className="bt-label">{r.kind === 'rupees' ? `${s.perYearPct > 0 ? '+' : ''}${s.perYearPct}% of the money a year` : 'growth a year'}</span>
        </div>
        <div className="bt-fig">
          <span className="bt-label">Worst fall</span>
          <b className="down">{r.worst}</b>
          <span className="bt-label">{s.goodYears} of {s.years} years in profit</span>
        </div>
      </div>
    </article>
  );
}

export default function BacktestApp() {
  const won = RESULTS.filter((r) => summarize(r).total > 0).length;
  const lost = RESULTS.length - won;
  return (
    <div className="ds bt">
      <section className="card bt-head">
        <div className="card-head">
          <h2 className="card-title">How our paper strategies did in the past</h2>
          <span className="bt-pills">
            <span className="bt-pill up">{won} made money</span>
            {lost > 0 && <span className="bt-pill down">{lost} lost</span>}
          </span>
        </div>
        <p className="bt-lead">Each card replays one strategy on the last 5 years of real prices, with all charges taken out. Only the strategies running on paper in the app are shown.</p>
        <div className="bt-read">
          <div><b>Money kept for it</b><span>The capital set aside for this strategy.</span></div>
          <div><b>Made in 5 years</b><span>Total profit from Nov 2021 to Oct 2026.</span></div>
          <div><b>Average a year</b><span>That total split evenly over the 5 years.</span></div>
          <div><b>Worst fall</b><span>The biggest drop from a high before it recovered.</span></div>
        </div>
      </section>

      {SECTIONS.map((sec) => {
        const list = RESULTS.filter((r) => r.section === sec);
        if (!list.length) return null;
        return (
          <section className="card" key={sec}>
            <div className="card-head"><h3 className="card-title">{sec}</h3><span className="muted">{SECTION_NOTE[sec]}</span></div>
            <div className="bt-cards">{list.map((r) => <Card key={r.id} r={r} />)}</div>
          </section>
        );
      })}

      <section className="card bt-keep">
        <div className="card-head"><h3 className="card-title">Keep in mind</h3></div>
        <ul>
          <li>Past results are a guide, not a promise. A real year can be worse than any year here.</li>
          <li>The graph line starts at zero (or at ₹5L for stock books). Green above the line is profit, red below is loss.</li>
          <li>Stock books are shown as % growth on ₹5L, before tax.</li>
          <li>Everything stays on paper until the review in January.</li>
        </ul>
      </section>
    </div>
  );
}
