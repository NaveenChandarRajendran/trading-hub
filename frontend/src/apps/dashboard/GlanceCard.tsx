// One live app at a glance: title, verdict pill, 1-2 figures, "As of 11:05 IST" and a link to the full app.
// Every card renders its own loading / error / token / stale / empty state, so one failing feature never hides the rest.
import { Link } from 'react-router-dom';
import { Pill, type Tone } from '../../shared/ui';
import type { CardModel, Verdict } from './logic/cards';

const VERDICT_TONE: Record<Verdict, Tone> = { Bullish: 'up', Bearish: 'down', Neutral: 'neutral' };

function Body({ c }: { c: CardModel }) {
  if (c.state === 'loading') return <p className="db-glance-note">Loading…</p>;
  if (c.state === 'token') return <p className="db-glance-note err">Dhan token expired. Send a new one (POST /api/token).</p>;
  if (c.state === 'error') return <p className="db-glance-note err">{c.message || 'Could not load.'}</p>;
  if (!c.figures.length) return <p className="db-glance-note">{c.message || 'No data yet.'}</p>;
  return (
    <>
      <dl className="db-figs">
        {c.figures.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd className={`num ${f.tone ?? ''}`}>{f.value}</dd>
          </div>
        ))}
      </dl>
      {c.message && <p className="db-glance-note">{c.message}</p>}
    </>
  );
}

export function GlanceCard({ c, stale }: { c: CardModel; stale: boolean }) {
  const isStale = stale || c.state === 'stale';
  return (
    <section className="card db-glance" aria-label={c.title}>
      <div className="db-glance-head">
        <h3 className="card-title">{c.title}</h3>
        {c.verdict ? <Pill tone={VERDICT_TONE[c.verdict]}>{c.verdict}</Pill> : c.tag ? <Pill tone="neutral">{c.tag}</Pill> : null}
      </div>
      <Body c={c} />
      <div className="db-glance-foot">
        <span className={isStale ? 'warn' : ''}>
          {c.asOf ? `As of ${c.asOf} IST` : ''}{isStale && (c.asOf ? ' · stale' : 'Stale')}
        </span>
        <Link to={c.path}>Open →</Link>
      </div>
    </section>
  );
}

export function Consensus({ counts }: { counts: Record<Verdict, number> }) {
  return (
    <p className="db-consensus" title="Count of the cards' own verdicts. Not a combined signal.">
      <span className="up">Bullish {counts.Bullish}</span> · <span className="down">Bearish {counts.Bearish}</span> ·{' '}
      <span>Neutral {counts.Neutral}</span>
    </p>
  );
}
