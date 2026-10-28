"""
notify.py - short phone alerts through a Telegram bot (owner, 27-Oct-2026: "the purpose of this app is to avoid screen
time"). One message when a rule enters, one when it exits (with the day's P&L so far), and a day summary after the close.
PAPER ONLY: this module only sends text; it never places or changes an order.

Setup: Setup_Phone_Alerts.bat -> setup_phone_alerts.py asks for the bot key in a hidden prompt and saves
{"botToken", "chatId"} to ~/TradingHubKeys/telegram.json (outside the Trading Journey folder and outside git).
No file = alerts off, silently. Sending runs on its own thread: a slow or failed send never delays the trader; a failure
is logged and raised once a day as an app alert.
"""
import json
import logging
import os
import queue
import threading

import requests

from journal import strategy_of

log = logging.getLogger("notify")

DEFAULT_KEYS_FILE = "~/TradingHubKeys/telegram.json"
API = "https://api.telegram.org/bot{token}/{method}"


def load_keys(path=DEFAULT_KEYS_FILE):
    """(bot token, chat id) or None when phone alerts are not set up."""
    p = os.path.expanduser(path)
    try:
        with open(p, encoding="utf-8-sig") as f:  # utf-8-sig: Windows PowerShell 5 writes a BOM
            d = json.load(f)
    except (OSError, ValueError):
        return None
    token, chat = str(d.get("botToken") or "").strip(), str(d.get("chatId") or "").strip()
    return (token, chat) if token and chat else None


def rupees(v):
    v = v or 0
    return f"{'+' if v > 0 else '−' if v < 0 else ''}₹{abs(v):,.0f}"


def entry_text(t):
    stop = f" · stop {t['stop']:.2f}" if t.get("stop") else ""
    target = f" · target {t['target']:.2f}" if t.get("target") else ""
    return (f"🔵 ENTRY · {strategy_of(t)}\n{t['instrument']['name']} · {t['qty']} qty @ {t['entryPrice']:.2f} "
            f"· {str(t.get('entryTime') or '')[:5]}{stop}{target}")


def exit_text(t, day_pnl=None):
    pnl = t.get("netPnl") if t.get("netPnl") is not None else t.get("grossPnl")
    mark = "🟢" if (pnl or 0) > 0 else "🔴"
    exit_price = t.get("exitPrice")
    line = (f"{mark} EXIT · {strategy_of(t)} · {rupees(pnl)}\n{t['instrument']['name']} · "
            f"{t['entryPrice']:.2f} → {exit_price:.2f}" if exit_price is not None else
            f"{mark} EXIT · {strategy_of(t)} · {rupees(pnl)}\n{t['instrument']['name']}")
    line += f" · {t.get('exitReason') or 'exit'} · {str(t.get('exitTime') or '')[:5]}"
    if day_pnl is not None:
        line += f"\nToday so far: {rupees(day_pnl)}"
    return line


def market_line(market):
    """market: [(name, spot, previous close)] -> "Market: Nifty 22,718 (−0.4%) · Bank Nifty 54,347 (−0.3%)"."""
    parts = []
    for name, spot, prev in market or ():
        if not spot:
            continue
        pct = f" ({'+' if spot >= prev else '−'}{abs(spot / prev - 1) * 100:.1f}%)" if prev else ""
        parts.append(f"{name} {spot:,.0f}{pct}")
    return "Market: " + " · ".join(parts) if parts else None


def near_text(n):
    """A rule's closest call that did not trade: {"met", "total", "symbol", "side", "time", "missing"}."""
    side = {"CE": "call", "PE": "put"}.get(n.get("side"), (n.get("side") or "").lower())
    where = f" on {'Bank Nifty' if n.get('symbol') == 'BANKNIFTY' else 'Nifty'}{' ' + side if side else ''}"
    missing = f" (missing: {', '.join(n['missing'])})" if n.get("missing") else ""
    return f"{n['met']} of {n['total']}{where} at {n['time']}{missing}"


def _won_lost(mine):
    net = sum(r.get("netPnl") or 0 for r in mine)
    won = sum(1 for r in mine if (r.get("netPnl") or 0) > 0)
    return net, won, "🟢" if net > 0 else "🔴" if net < 0 else "⚪"


def _names(rows, order):
    return list(order) + sorted({r["strategy"] for r in rows} - set(order))  # a rule not in the list still shows


def summary_text(day, rows, order, market=None, near=None):
    """Day summary from the journal's trade rows (all accounts, Manual too). order: strategy names in board order.
    market: see market_line. near: strategy name -> the day's closest call (near_text), shown for a rule with no trade."""
    closed = [r for r in rows if r["status"] == "closed"]
    still_open = [r for r in rows if r["status"] == "open"]
    total = sum(r.get("netPnl") or 0 for r in closed)
    lines = [f"📋 Day summary {day} · {rupees(total)}"]
    if market_line(market):
        lines.append(market_line(market))
    for name in _names(rows, order):
        mine = [r for r in closed if r["strategy"] == name]
        if not mine:
            if any(r["strategy"] == name for r in still_open):
                lines.append(f"🔵 {name}: still in a trade")
            else:
                close = (near or {}).get(name)
                lines.append(f"⚪ {name}: no trade" + (f" (closest: {near_text(close)})" if close else ""))
            continue
        net, won, mark = _won_lost(mine)
        lines.append(f"{mark} {name}: {rupees(net)} ({len(mine)} trade{'s' if len(mine) != 1 else ''}, {won} won)")
    if still_open:
        lines.append(f"⚠ Still open: {', '.join(r['instrument'] or '?' for r in still_open)}")
    return "\n".join(lines)


def open_text(day, order):
    """9:15 message (owner 27-Oct-2026: "Please allow 9:15 as well")."""
    rules = ", ".join(n for n in order if n != "Manual")
    return f"🔔 Market open · {day} 9:15\nWatching: {rules}\nYou'll get a message on every entry and exit, and an update every hour from 10:15."


def hourly_text(at, rows, order, market=None, near=None, live=None, manual_live=None):
    """Hourly update (owner 27-Oct-2026: "a short summary every hour, then the consolidated one at 3.30").
    rows: the day's journal rows. live: open trade id -> P&L now. manual_live: open P&L of the owner's own trades.
    near: strategy name -> this hour's closest call that did not trade (near_text)."""
    live = live or {}
    closed = [r for r in rows if r["status"] == "closed"]
    still_open = [r for r in rows if r["status"] == "open"]
    open_rule = sum(live.get(r["id"]) or 0 for r in still_open if r["strategy"] != "Manual")
    total = sum(r.get("netPnl") or 0 for r in closed) + open_rule + (manual_live or 0)
    lines = [f"⏰ {at} update · Today so far: {rupees(total)}"]
    if market_line(market):
        lines.append(market_line(market))
    for name in _names(rows, order):
        mine = [r for r in closed if r["strategy"] == name]
        held = [r for r in still_open if r["strategy"] == name]
        if name == "Manual":
            if not mine and not held:
                lines.append("👤 My trades: none")
                continue
            bits = []
            if held:
                bits.append(f"{len(held)} open, {rupees(manual_live)} now" if manual_live is not None else f"{len(held)} open")
            if mine:
                net, won, _ = _won_lost(mine)
                bits.append(f"booked {rupees(net)} ({len(mine)} closed, {won} won)")
            lines.append("👤 My trades: " + "; ".join(bits))
            continue
        booked = ""
        if mine:
            net, won, mark = _won_lost(mine)
            if len(mine) == 1:
                r = mine[0]
                booked = f"{'won' if net > 0 else 'lost' if net < 0 else 'flat'} {rupees(net)} ({r.get('exitReason') or 'exit'}, {r['instrument']})"
            else:
                booked = f"{rupees(net)} ({len(mine)} trades, {won} won)"
        if held:
            r = held[0]
            pnl = live.get(r["id"])
            text = f"🔵 {name}: in trade {r['instrument']}" + (f", {rupees(pnl)} now" if pnl is not None else "")
            lines.append(text + (f"; earlier {booked}" if booked else ""))
        elif mine:
            lines.append(f"{mark} {name}: {booked}")
        elif (near or {}).get(name):
            lines.append(f"🟡 {name}: came close, {near_text(near[name])}")
        else:
            lines.append(f"⚪ {name}: no setup this hour")
    return "\n".join(lines)


def _lakh(v):
    a = abs(v)
    num = f"{a / 100000:.2f} L" if a >= 100000 else f"{a / 1000:.1f} k" if a >= 1000 else f"{a:.0f}"
    return f"{'+' if v > 0 else '−' if v < 0 else ''}{num}"


def oi_block(d):
    """Market read of one index for the phone (owner 28-Oct-2026: OI, OI change, Trending OI last 5, OI levels, order flow).
    d: {"name", "spot", "prev", "oi", "sb", "toi": [strength %, newest first], "support", "resistance", "flow"}."""
    spot, prev = d.get("spot"), d.get("prev")
    if not spot:
        return []
    pct = f" ({'+' if spot >= prev else '−'}{abs(spot / prev - 1) * 100:.1f}%)" if prev else ""
    out = [f"📊 {d['name']} {spot:,.0f}{pct}"]
    oi, sb = d.get("oi"), d.get("sb")
    if oi or sb:
        both = " → agree" if oi and oi == sb else " → mixed" if oi and sb else ""
        out.append(f"• OI (Dhan): {oi or '—'} · OI change (Sensibull): {sb or '—'}{both}")
    toi = [x for x in (d.get("toi") or [])[:5] if x is not None]
    if toi:
        bear = sum(1 for x in toi if x < 0)
        side = "bearish" if bear > len(toi) / 2 else "bullish" if bear < len(toi) / 2 else "mixed"
        trend = ""
        if len(toi) >= 2 and side != "mixed":
            trend = ", getting stronger" if abs(toi[0]) > abs(toi[-1]) else ", getting weaker"
        out.append(f"• Trending OI last {len(toi)}: {' '.join(f'{x:+.0f}' for x in toi)} → {side}{trend}")
    if d.get("support") or d.get("resistance"):
        out.append(f"• OI support {d.get('support') or 0:,.0f} · resistance {d.get('resistance') or 0:,.0f}")
    if d.get("flow") is not None:
        f = d["flow"]
        who = "buyers ahead" if f > 0 else "sellers ahead" if f < 0 else "even"
        out.append(f"• Order flow: {_lakh(f)} ({who})")
    return out


def with_market(text, details):
    """Adds the market blocks (oi_block per index) under a phone message."""
    blocks = ["\n".join(b) for b in (oi_block(d) for d in details or ()) if b]
    return "\n\n".join([text] + blocks)


class Notifier:
    """Queues texts and sends them to Telegram on a background thread. Disabled when no keys are set up."""

    def __init__(self, keys_file=DEFAULT_KEYS_FILE, alert=lambda kind, msg: None, post=None, start=True):
        self.keys_file, self.alert = keys_file, alert
        self.post = post or (lambda url, body: requests.post(url, json=body, timeout=10))
        self.q = queue.Queue()
        self.sent, self.failed = 0, 0
        self._warned_day = None
        if start:
            threading.Thread(target=self._run, name="notify", daemon=True).start()

    @property
    def enabled(self):
        return load_keys(self.keys_file) is not None

    def send(self, text):
        if self.enabled:
            self.q.put(text)

    def send_now(self, text):
        """Send one message and return (ok, error). Used by the worker, the setup script and the test button."""
        keys = load_keys(self.keys_file)
        if not keys:
            return False, "Phone alerts are not set up (run Setup_Phone_Alerts.bat)."
        token, chat = keys
        last = ""
        for _ in range(2):
            try:
                r = self.post(API.format(token=token, method="sendMessage"), {"chat_id": chat, "text": text})
                if getattr(r, "status_code", 200) == 200:
                    self.sent += 1
                    return True, ""
                last = f"Telegram answered {r.status_code}"
            except Exception as e:  # network down, DNS ...: never let it reach the trader
                last = type(e).__name__
        self.failed += 1
        return False, last

    def _run(self):
        while True:
            text = self.q.get()
            ok, err = self.send_now(text)
            if not ok:
                log.warning("phone alert not sent: %s", err)
                from datetime import date
                if self._warned_day != date.today():
                    self._warned_day = date.today()
                    self.alert("api", f"A phone alert could not be sent ({err}). Alerts still show here in the app.")

    # ---------- trader events ----------
    def on_order(self, trade, event, day_pnl=None):
        """entry / exit <reason> from the auto trader (rule trades, and manual trades given a stop + target)."""
        try:
            if event == "entry":
                self.send(entry_text(trade))
            elif event.startswith("exit") and trade.get("status") == "closed":
                self.send(exit_text(trade, day_pnl))
        except Exception:
            log.exception("phone alert text failed for %s", event)


def day_rows(journal, paper, day):
    """Every trade of the day as the journal API returns it: rule trades + the manual account's round trips."""
    from journal import manual_round_trips
    rows = list(journal.trades(day, day)) if journal is not None else []
    if paper is not None:
        try:
            rows += manual_round_trips(paper.trades(day), day)
        except Exception:
            log.exception("phone alerts: manual trades %s", day)
    return rows


def day_pnl(rows):
    """Booked P&L of the day (closed trades, after charges)."""
    return round(sum(r.get("netPnl") or 0 for r in rows if r["status"] == "closed"), 2)


def register(app, phone):
    """GET /api/notify/status, POST /api/notify/test (sends one test message to the phone)."""
    from fastapi import HTTPException

    @app.get("/api/notify/status")
    def status():
        return {"enabled": phone.enabled, "sent": phone.sent, "failed": phone.failed}

    @app.post("/api/notify/test")
    def test():
        ok, err = phone.send_now("✅ Test from Trading Hub: phone alerts work.")
        if not ok:
            raise HTTPException(400, err)
        return {"ok": True}
