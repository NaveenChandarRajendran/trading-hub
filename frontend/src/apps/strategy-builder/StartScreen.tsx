// The Builder with no legs: three ways to start, as large cards (Tab / arrow keys move, Enter opens).
import { useRef, type KeyboardEvent } from 'react';

const CARDS = [
  { id: 'template', icon: '▦', title: 'Start from a template', text: 'Iron condors, straddles, spreads and your own rules. Guided in three steps with checks before you trade.' },
  { id: 'chain', icon: '⊞', title: 'Pick strikes from the option chain', text: 'Mark Buy / Sell on the chain in a side drawer; legs and payoff update as you go.' },
  { id: 'open', icon: '⎘', title: 'Open a draft or portfolio', text: 'A design you saved, or what one of your strategies holds right now.' },
] as const;
export type StartChoice = (typeof CARDS)[number]['id'];

export function StartScreen({ onChoose, disabledWhy }: { onChoose: (c: StartChoice) => void; disabledWhy?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const key = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    refs.current[(i + d + CARDS.length) % CARDS.length]?.focus();
  };
  return (
    <section className="sb-start" aria-label="Start a design">
      <h2 className="sb-start-title">Build a strategy</h2>
      <div className="sb-start-cards" role="group" aria-label="Ways to start">
        {CARDS.map((c, i) => (
          <button key={c.id} ref={(el) => { refs.current[i] = el; }} type="button" className="card sb-start-card"
            onClick={() => onChoose(c.id)} onKeyDown={(e) => key(e, i)} disabled={c.id !== 'open' && !!disabledWhy}
            title={c.id !== 'open' ? disabledWhy : undefined}>
            <span className="sb-start-icon" aria-hidden>{c.icon}</span>
            <span className="sb-start-name">{c.title}</span>
            <span className="muted sb-start-text">{c.text}</span>
          </button>
        ))}
      </div>
      {disabledWhy && <p className="muted sb-small">{disabledWhy}</p>}
    </section>
  );
}
