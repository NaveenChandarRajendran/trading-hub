"""
orb_replay.py - the ORB Algo's rules (orb_logic.replay_day, the same code as live) over Dhan's 1-minute NIFTY index
history, in NIFTY SPOT POINTS (before costs), next to the numbers of Groww's backtest video. Read-only market data: no
orders, no database. Run after market hours (it uses the Dhan token in backend/.env.local):

    python orb_replay.py                 # as far back as Dhan's 1-minute history goes (89-day windows, cached)
    python orb_replay.py --from 2025-01-01 --to 2026-11-12

Windows are cached in data/orb_history/ (a finished window never changes), so a second run makes no Dhan call for them.
The result is printed and written to docs/strategies/orb-replay.md.
"""
import argparse
import json
import os
import time
from collections import defaultdict
from datetime import date, datetime, timedelta

import orb_config as cfg
from orb_logic import replay_day
from store import IST

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "data", "orb_history")
DOC = os.path.join(HERE, "..", "docs", "strategies", "orb-replay.md")
WINDOW_DAYS = 89
NL = chr(10)
# Groww's video: NIFTY, Jan 2020 – Sep 2026, 1,668 sessions, spot points before costs
VIDEO = {"b60": (648, 7021), "r30": (713, 6487), "v5": (599, 5424)}


def by_day(candles):
    days = defaultdict(list)
    for c in candles:
        days[datetime.fromtimestamp(c["time"], IST).date().isoformat()].append(c)
    return dict(sorted(days.items()))


def summarize(trades):
    """trades: [trade] (orb_logic trades with setup and points) -> {setup: {trades, wins, losses, points, winRate, perTrade}}."""
    out = {}
    for k in cfg.SETUPS:
        pts = [t["points"] for t in trades if t["setup"] == k and t["points"] is not None]
        wins = sum(1 for p in pts if p > 0)
        losses = sum(1 for p in pts if p < 0)
        out[k] = {"trades": len(pts), "wins": wins, "losses": losses, "points": round(sum(pts), 2),
                  "winRate": round(wins / len(pts) * 100, 1) if pts else None,
                  "perTrade": round(sum(pts) / len(pts), 2) if pts else None}
    return out


def replay(days, s=None):
    s = s or cfg.merged()
    trades = []
    for day, candles in days.items():
        for t in replay_day(candles, s):
            trades.append({**t, "day": day})
    return trades


# ---------------------------------------------------------------- Dhan history (read-only)
def _window(client, start, end, today):
    """Candles of [start, end] (IST dates); cached when the window is finished (ends before today)."""
    from candles import parse_intraday
    path = os.path.join(CACHE, f"NIFTY_1m_{start}_{end}.json")
    if os.path.exists(path):
        return json.load(open(path, encoding="utf-8"))
    # fromDate at 09:00: from 09:15:00 Dhan leaves out the first day's 09:15 candle (the day's open); toDate is exclusive
    payload = client.intraday("NIFTY", f"{start} 09:00:00", f"{end + timedelta(days=1)} 09:00:00")
    rows = parse_intraday(payload)
    if end < today:
        os.makedirs(CACHE, exist_ok=True)
        json.dump(rows, open(path, "w", encoding="utf-8"))
    return rows


def fetch(client, from_day=None, to_day=None, log=print):
    """1-minute candles from to_day back to from_day (or as far back as Dhan has: two empty windows in a row end it)."""
    from dhan_client import DhanError
    today = datetime.now(IST).date()
    end = to_day or today
    candles, empty = [], 0
    while True:
        start = end - timedelta(days=WINDOW_DAYS - 1)
        if from_day and start < from_day:
            start = from_day
        rows, err = None, None
        for attempt in range(3):  # a rate-limit answer must not end the history early
            try:
                rows = _window(client, start, end, today)
                break
            except DhanError as e:
                err = e
                time.sleep(3 * (attempt + 1))
        if rows is None:
            if from_day:
                raise SystemExit(f"Dhan refused {start} .. {end} three times ({str(err)[:160]}): the asked period is incomplete")
            log(f"  {start} .. {end}: Dhan said {str(err)[:160]}; taking this as the start of the history")
            break
        log(f"  {start} .. {end}: {len(rows)} candles")
        candles = rows + candles
        empty = empty + 1 if not rows else 0
        if empty >= 2 or (from_day and start <= from_day):
            break
        end = start - timedelta(days=1)
    return candles


def section(title, days, trades, note=""):
    """One period's table: each setup next to the video's numbers."""
    res = summarize(trades)
    first, last = (next(iter(days)), list(days)[-1]) if days else ("-", "-")
    lines = [f"## {title}", "", f"**{first} to {last}, {len(days)} sessions.**"
             + (" Shorter than the video's 1,668 sessions: compare win rate and points per trade, not totals."
                if len(days) < 1600 else ""), ""]
    if note:
        lines += [note, ""]
    lines += ["| Setup | Trades | Win rate | Total points | Points / trade | Video: trades | Video: points | Video: pts / trade |",
              "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for k, (name, _m) in cfg.SETUPS.items():
        r, (vt, vp) = res[k], VIDEO[k]
        wr = "-" if r["winRate"] is None else f"{r['winRate']:.1f}%"
        pt = "-" if r["perTrade"] is None else f"{r['perTrade']:+.2f}"
        lines.append(f"| {name} | {r['trades']} | {wr} | {r['points']:+,.2f} | {pt} | {vt} | +{vp:,} | {vp / vt:+.2f} |")
    return NL.join(lines) + NL, res


HEADER = ("# ORB Algo replay (spot points, before costs)" + NL + NL +
          "Generated {at} IST by `backend/orb_replay.py` with the live rules (`orb_logic.replay_day`, default settings) "
          "on Dhan's NIFTY index 1-minute candles. Video: Groww's ORB backtest, NIFTY, Jan 2020 - Sep 2026, 1,668 "
          "sessions. Entries and stops on 1-minute closes, the exit at the close of the 15:24 candle (15:25); spot points "
          "only (no option premiums, charges or slippage). Sessions with under 300 candles or without their 09:15 candle "
          "(special / broken days) are left out." + NL + NL)


def report(days, trades, note=""):
    text, res = section("Replay", days, trades, note)
    return HEADER.format(at=datetime.now(IST).strftime("%d-%b-%Y %H:%M")) + text, res


def full_days(candles):
    """Sessions that start with their 09:15 candle (the day's open and the ORs need it) and have 300+ candles."""
    all_days = by_day(candles)
    ok = {d: c for d, c in all_days.items()
          if len(c) >= 300 and datetime.fromtimestamp(c[0]["time"], IST).strftime("%H:%M") == "09:15"}
    return ok, len(all_days)


def main():
    ap = argparse.ArgumentParser(description="Replay the ORB Algo over Dhan's 1-minute NIFTY history (spot points).")
    ap.add_argument("--from", dest="from_day", type=date.fromisoformat)
    ap.add_argument("--to", dest="to_day", type=date.fromisoformat)
    ap.add_argument("--no-doc", action="store_true", help="print only, don't write docs/strategies/orb-replay.md")
    a = ap.parse_args()
    from dhan_client import DhanClient
    from envfile import load_env_file
    load_env_file(os.path.join(HERE, ".env.local"))
    print("Fetching NIFTY 1-minute history from Dhan (read-only)...")
    candles = fetch(DhanClient(), a.from_day, a.to_day)
    days, n_all = full_days(candles)
    note = f"{n_all - len(days)} short session(s) left out." if n_all > len(days) else ""
    parts = []
    if not a.from_day and not a.to_day:  # the video's period first, then everything Dhan has
        video = {d: c for d, c in days.items() if "2020-01-01" <= d <= "2026-09-30"}
        parts.append(section("The video's period (Jan 2020 - Sep 2026)", video, replay(video))[0])
        parts.append(section("All of Dhan's 1-minute history", days, replay(days), note)[0])
    else:
        parts.append(section("Replay", days, replay(days), note)[0])
    text = HEADER.format(at=datetime.now(IST).strftime("%d-%b-%Y %H:%M")) + NL.join(parts)
    print(text)
    if not a.no_doc:
        with open(DOC, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"Written to {os.path.relpath(DOC, HERE)}")


if __name__ == "__main__":
    main()
