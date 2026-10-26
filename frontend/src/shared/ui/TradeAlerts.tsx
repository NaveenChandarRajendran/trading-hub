// Trade alerts in the top bar (owner 26-Oct-2026): every 15 s, today's paper trades (GET /api/journal/trades); a new
// entry or exit plays a short sound, shows a desktop pop-up (if allowed) and a note in the corner for 20 s. Works on
// every page, also while the tab is in the background. The button switches alerts on / off (remembered).
import { useEffect, useRef, useState } from 'react';
import { API_BASE, getJson } from '../api';
import { diffTrades, type AlertTrade, type TradeEvent } from '../live/tradeAlerts';

const KEY = 'alerts.on';
const POLL_MS = 15000;
const SHOW_MS = 20000;

const istToday = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

function readOn() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

let audio: AudioContext | null = null;
function unlockAudio() {
  try {
    audio = audio ?? new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}

/** Two short tones: rising for an entry, falling for an exit. */
function beep(kind: TradeEvent['kind']) {
  if (!audio) return;
  const notes = kind === 'entry' ? [660, 880] : [880, 520];
  notes.forEach((f, i) => {
    const o = audio!.createOscillator();
    const g = audio!.createGain();
    o.frequency.value = f;
    g.gain.value = 0.15;
    o.connect(g).connect(audio!.destination);
    const t = audio!.currentTime + i * 0.22;
    o.start(t);
    o.stop(t + 0.18);
  });
}

function popup(e: TradeEvent) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(e.title, { body: e.body });
  } catch {
    /* pop-ups not available */
  }
}

export function TradeAlerts() {
  const [on, setOn] = useState(readOn);
  const [shown, setShown] = useState<(TradeEvent & { at: number })[]>([]);
  const known = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    const unlock = () => unlockAudio(); // browsers allow sound only after the first click on the page
    document.addEventListener('click', unlock, { once: true });
    return () => document.removeEventListener('click', unlock);
  }, []);

  useEffect(() => {
    if (!on) return;
    let stop = false;
    const poll = async () => {
      try {
        const day = istToday();
        const r = await getJson<{ rows: AlertTrade[] }>(API_BASE, `/api/journal/trades?from=${day}&to=${day}`);
        if (stop) return;
        const d = diffTrades(known.current, r.rows);
        known.current = d.known;
        if (d.events.length) {
          const now = Date.now();
          setShown((s) => [...s.filter((x) => now - x.at < SHOW_MS), ...d.events.map((e) => ({ ...e, at: now }))]);
          d.events.forEach((e, i) => setTimeout(() => { beep(e.kind); popup(e); }, i * 700));
        }
      } catch {
        /* backend not running: try again next time */
      }
    };
    void poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [on]);

  useEffect(() => {
    if (!shown.length) return;
    const t = setTimeout(() => setShown((s) => s.filter((x) => Date.now() - x.at < SHOW_MS)), SHOW_MS);
    return () => clearTimeout(t);
  }, [shown]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    try {
      localStorage.setItem(KEY, next ? 'on' : 'off');
    } catch {
      /* not remembered */
    }
    if (next) {
      unlockAudio();
      known.current = null;
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
      } catch {
        /* pop-ups not available */
      }
    }
  };

  return (
    <>
      <button className={`btn ghost ${on ? 'alerts-on' : ''}`} onClick={toggle}
        title="Sound and desktop pop-up when a paper strategy enters or exits a trade">{on ? 'Trade alerts on' : 'Trade alerts off'}</button>
      {shown.length > 0 && (
        <div className="trade-toasts" role="status" aria-live="polite">
          {shown.map((e) => (
            <div key={`${e.at}-${e.title}`} className={`trade-toast ${e.kind}`}>
              <b>{e.title}</b>
              <span>{e.body}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
