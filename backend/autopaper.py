"""
autopaper.py - automatic PAPER trades from the two rules. PAPER ONLY: the Trading Hub rule trades on the Trading Hub
paper account (paper_engine.py, simulation), the MegaBull rule on MegaBull's virtual-trading API. No code path in this
module can reach a real broker; there is no LIVE mode.

Safety (owner's brief, Part 3):
- Kill switch: Auto ON / OFF (saved; OFF until the owner turns it on). Nothing is sent while it is OFF.
- Daily limits per account: max trades per day, max paper loss per day. Hitting one stops new entries for the day and
  raises one alert.
- Never sends an order when the market is closed, a position is already open on that index on that account, the daily
  limit is reached, or the previous order's status is unknown.
- An API call that fails twice stops that account for the day and raises an alert. Every MegaBull request and
  response is logged (without the key) by megabull_client.

Trade flow (docs/strategies/*.md):
- Entry: market BUY, 1 lot, ATM strike, nearest expiry (the next one on expiry day), right after the signal candle.
- Stop: pending stop SELL at fill x (1 - stop %). Target: watched on LTP every 2 s; at the target the stop is
  cancelled and a market SELL sent (the Trading Hub paper account allows one pending SELL per position).
- Exits: stop, target, signal exit (Trading Hub rule), or the time exit before 15:15 (stray orders cancelled first).
- Highest / lowest premium of every trade is recorded; one row per closed trade goes to the trade log CSV.
"""
import csv
import json
import logging
import math
import os
import threading
import time
from datetime import datetime, timedelta

from sig_indicators import IST
from sig_rules import NOT_CHECKED, PASS, trading_hub_exit

log = logging.getLogger("autopaper")
TICK = 0.05
TH, MB = "tradingHub", "megabull"
ACCOUNT_NAMES = {TH: "Trading Hub", MB: "MegaBull"}
D2 = "dharaniV2"
# rule (sig_rules result "rule") -> paper account. A rule is a "slot": one open position per slot per index, so
# MegaBull's v1 rule and Dharani v2 (owner, 25-Oct-2026) can both hold a trade on the same account.
RULE_ACCOUNT = {TH: TH, MB: MB, D2: MB}


def _entry_rsi(state, side):
    """RSI at entry: the 5-minute state's RSI, or Dharani v2's (index for a call, futures for a put)."""
    if "ind" in state:
        return state["ind"]["rsi"][state["i"]]
    src = state.get("idx") if side == "CE" else state.get("fut")
    return ((src or {}).get("ind") or {}).get("rsi")


def slot_of(t):
    return t.get("slot") or t["account"]  # trades saved before slots existed: slot = account


TRADE_LOG_FIELDS = [
    "date", "index", "account", "rule", "grade", "side", "instrument", "entry_time", "entry_price", "qty", "stop", "target",
    "exit_time", "exit_price", "exit_reason", "gross_pnl", "charges", "net_pnl", "highest_premium", "lowest_premium",
    "rsi_at_entry", "vix", "pcr", "trending_oi_strength", "delta_status", "checks",
    # shadow after the exit (record only, filled at the end of the day)
    "highest_premium_after_exit", "time_of_high_after_exit", "lowest_premium_after_exit", "premium_at_1515",
    "spot_at_1515", "trend_still_held_at_1515", "missed_profit_pct_of_entry",
]
SHADOW_SKIP_FIELDS = [
    "date", "index", "candle_time", "setup", "rule", "filters_missed", "why_skipped", "instrument", "reference_premium",
    "stop_level", "target_level", "highest_premium", "time_of_high", "lowest_premium", "time_of_low", "target_reached",
    "target_time", "stop_hit_first", "stop_time", "what_happened_next", "would_it_have_worked", "skip_verdict",
]
SHADOW_EXIT_UNTIL = "15:30"
SHADOW_SKIP_UNTIL = "15:15"
SKIP_REPEAT_MINUTES = 30  # one skip row per rule / index / side within this window


def floor_tick(p):
    return round(math.floor(p / TICK + 1e-9) * TICK, 2)


def ceil_tick(p):
    return round(math.ceil(p / TICK - 1e-9) * TICK, 2)


class AccountError(Exception):
    pass


# ======================================================================= accounts
class TradingHubAccount:
    """The Trading Hub paper account (paper_api.PaperService)."""
    key, rule = TH, "tradingHub"

    def __init__(self, paper):
        self.paper = paper

    def available(self):
        return True, ""

    def expiries(self, symbol):
        return self.paper.option_expiries(symbol)

    def instrument(self, symbol, expiry, spot, side):
        rows = [r for r in self.paper.instrument_chain(symbol, expiry) if r[side.lower()]]
        if not rows:
            raise AccountError(f"No {symbol} {expiry} {side} options in Dhan's instrument list")
        r = min(rows, key=lambda x: (abs(x["strike"] - spot), x["strike"]))
        leg = r[side.lower()]
        return {"id": leg["securityId"], "name": leg["name"], "strike": leg["strike"], "expiry": expiry,
                "optionType": side, "lotSize": leg["lotSize"]}

    def neighbours(self, symbol, expiry, spot):
        """ATM CE / PE and one strike each side, kept subscribed so an entry has a price at once."""
        rows = self.paper.instrument_chain(symbol, expiry)
        rows = sorted(rows, key=lambda x: abs(x["strike"] - spot))[:3]
        return [r[k]["securityId"] for r in rows for k in ("ce", "pe") if r[k]]

    def ready(self, inst):
        return self.paper.has_book(inst["id"])

    def ltp(self, inst):
        return self.paper.ltp(inst["id"])

    def buy(self, inst, lots):
        o = self.paper.place_order(inst["id"], "BUY", lots, "MARKET")
        if o["status"] != "FILLED":
            raise AccountError(f"Entry not filled: {o['status']} {o.get('reason', '')}".strip())
        return o["id"], o["avg_price"], o["qty"]

    def stop(self, inst, lots, qty, trigger):
        o = self.paper.place_order(inst["id"], "SELL", lots, "SL-M", trigger_price=trigger)
        if o["status"] not in ("PENDING", "TRIGGERED", "FILLED"):
            raise AccountError(f"Stop not accepted: {o['status']} {o.get('reason', '')}".strip())
        return o["id"]

    def order(self, order_id):
        o = self.paper.order(order_id)
        if not o:
            return None
        return {"status": {"PENDING": "OPEN", "TRIGGERED": "OPEN"}.get(o["status"], o["status"]), "avgPrice": o["avg_price"]}

    def cancel(self, order_id):
        o = self.paper.order(order_id)
        if o and o["status"] in ("PENDING", "TRIGGERED"):
            self.paper.cancel_order(order_id)

    def sell(self, inst, lots, qty):
        o = self.paper.place_order(inst["id"], "SELL", lots, "MARKET")
        if o["status"] != "FILLED":
            raise AccountError(f"Exit not filled: {o['status']} {o.get('reason', '')}".strip())
        return o["id"], o["avg_price"]

    def position_qty(self, inst):
        return self.paper.open_qty(inst["id"])

    def last_sell_price(self, inst):
        sells = [t for t in self.paper.trades() if t["security_id"] == inst["id"] and t["side"] == "SELL"]
        return sells[-1]["price"] if sells else None

    def charges(self, trade):
        ids = {trade["entryOrderId"], trade.get("exitOrderId"), trade.get("stopOrderId")}
        return round(sum(t["charges"]["total"] for t in self.paper.trades() if t["order_id"] in ids), 2)


class MegaBullAccount:
    """MegaBull virtual trading (megabull_client.MegaBullClient). Stays unavailable until the key file exists, the
    rules are confirmed and the read-only check has run (config megabull.enabled)."""
    key, rule = MB, "megabull"
    CHARGES_PCT = 0.37  # owner's tracker estimate: 0.37% of the money in the trade (MegaBull's Monthly Report, 9-Oct)

    FALLBACK_LOT = {"NIFTY": 65, "BANKNIFTY": 30}  # only if Dhan's list cannot be read: MegaBull's file has no lot size

    def __init__(self, make_client, enabled, sl_buffer_pct, lot_size=None):
        self.make_client, self.enabled, self.sl_buffer = make_client, enabled, sl_buffer_pct
        self.lot_size = lot_size  # callable(symbol) -> exchange lot size from Dhan's instrument list, or None
        self._client, self._err = None, ""

    @property
    def client(self):
        if self._client is None:
            self._client = self.make_client()
        return self._client

    def available(self):
        if not self.enabled:
            return False, "MegaBull auto orders are off (config: megabull.enabled)."
        try:
            self.client
        except Exception as e:
            return False, str(e)
        return True, ""

    def expiries(self, symbol):
        return sorted({r["expiry"] for r in self.client.instruments() if r["symbol"] == symbol and r["expiry"] >= datetime.now(IST).date().isoformat()})

    def instrument(self, symbol, expiry, spot, side):
        rows = [r for r in self.client.instruments() if r["symbol"] == symbol and r["expiry"] == expiry and r["optionType"] == side]
        if not rows:
            raise AccountError(f"No MegaBull {symbol} {expiry} {side} options")
        r = min(rows, key=lambda x: (abs(x["strike"] - spot), x["strike"]))
        return {"id": r["token"], "name": f"{symbol} {expiry} {r['strike']:.0f} {side}", "strike": r["strike"], "expiry": expiry,
                "optionType": side, "lotSize": r["lotSize"] or self._lot(symbol)}

    def _lot(self, symbol):
        try:
            lot = self.lot_size(symbol) if self.lot_size else None
        except Exception:
            lot = None
        return int(lot) if lot else self.FALLBACK_LOT[symbol]

    def neighbours(self, symbol, expiry, spot):
        return []

    def ready(self, inst):
        return True

    def ltp(self, inst):
        return self.client.ltp(inst["id"])

    def _wait_fill(self, order_id, tries=10):
        for _ in range(tries):
            st = self.client.order_status(order_id)
            if st and st["status"] in ("COMPLETE", "COMPLETED", "FILLED", "EXECUTED", "TRADED"):
                return st["avgPrice"]
            if st and st["status"] in ("REJECTED", "CANCELLED", "CANCELED"):
                raise AccountError(f"MegaBull order {order_id} {st['status']}")
            time.sleep(1)
        raise AccountError(f"MegaBull order {order_id}: status unknown after {tries} s")

    def buy(self, inst, lots):
        qty = lots * inst["lotSize"]
        oid = self.client.place(inst["id"], qty, "BUY", "MKT")
        return oid, self._wait_fill(oid), qty

    def stop(self, inst, lots, qty, trigger):
        price = floor_tick(trigger * (1 - self.sl_buffer / 100))
        return self.client.place(inst["id"], qty, "SELL", "SL", price=price, trigger_price=trigger)

    def order(self, order_id):
        st = self.client.order_status(order_id)
        if st is None:
            return None
        s = st["status"]
        norm = "FILLED" if s in ("COMPLETE", "COMPLETED", "FILLED", "EXECUTED", "TRADED") else \
            "CANCELLED" if s in ("CANCELLED", "CANCELED") else "REJECTED" if s == "REJECTED" else "OPEN"
        return {"status": norm, "avgPrice": st["avgPrice"]}

    def cancel(self, order_id):
        self.client.cancel([order_id])

    def sell(self, inst, lots, qty):
        oid = self.client.place(inst["id"], qty, "SELL", "MKT")
        return oid, self._wait_fill(oid)

    def position_qty(self, inst):
        return None  # read from MegaBull's order status instead

    def last_sell_price(self, inst):
        return None

    def charges(self, trade):
        return round((trade["entryPrice"] * trade["qty"]) * self.CHARGES_PCT / 100, 2)


# ======================================================================= trader
class AutoTrader:
    def __init__(self, config, accounts, clock=lambda: datetime.now(IST), alert=lambda kind, msg: None,
                 on_order=lambda trade, event: None, state_path="data/autopaper_state.json"):
        self.cfg = config
        self.accounts = {a.key: a for a in accounts}
        self.clock, self.alert, self.on_order = clock, alert, on_order
        self.state_path = state_path
        self.lock = threading.RLock()
        self._busy = set()  # (account, symbol) with an entry or exit in progress
        self._stop_evt = threading.Event()
        self._thread = None
        self._last_stop_poll = {}
        self._watch = {}  # symbol -> neighbour ids for the Trading Hub account
        self._last_state = {}  # symbol -> the latest 5-minute state (spot and SuperTrend at 15:15 for the shadows)
        self.state = self._load()

    # ---------- persistence ----------
    def _load(self):
        try:
            s = json.load(open(self.state_path, encoding="utf-8"))
        except (OSError, ValueError):
            s = {}
        s.setdefault("auto", False)
        s.setdefault("day", "")
        s.setdefault("trades", [])
        s.setdefault("halted", {})
        s.setdefault("unknown", {})
        s.setdefault("shadows", [])
        s.setdefault("finished", "")
        return s

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.state_path) or ".", exist_ok=True)
            tmp = self.state_path + ".tmp"
            json.dump(self.state, open(tmp, "w", encoding="utf-8"), indent=1, default=str)
            os.replace(tmp, self.state_path)
        except OSError as e:
            log.warning("could not save the auto paper state: %s", e)

    def _roll_day(self):
        today = self.clock().date().isoformat()
        if self.state["day"] != today:
            still_open = [t for t in self.state["trades"] if t["status"] == "open"]
            for t in still_open:  # intraday only: anything left from an earlier day was squared off by the platform
                t.update(status="closed", exitReason="Time", exitTime=None, exitPrice=None)
            self.state.update(day=today, trades=[], halted={}, unknown={}, shadows=[], finished="")
            self._save()

    # ---------- switches ----------
    def set_auto(self, on):
        with self.lock:
            self.state["auto"] = bool(on)
            self._save()
        log.info("Auto %s", "ON" if on else "OFF")

    def status(self):
        with self.lock:
            self._roll_day()
            out = {"auto": self.state["auto"], "day": self.state["day"], "accounts": {}}
            for key, acc in self.accounts.items():
                ok, why = acc.available()
                trades = [t for t in self.state["trades"] if t["account"] == key]
                out["accounts"][key] = {
                    "name": ACCOUNT_NAMES[key], "available": ok, "message": why, "halted": self.state["halted"].get(key, ""),
                    "tradesToday": len(trades), "netToday": round(sum(t.get("netPnl") or 0 for t in trades if t["status"] == "closed"), 2),
                    "maxTrades": self.cfg["limits"]["maxTradesPerDay"], "maxLoss": self.cfg["limits"]["maxLossPerDay"],
                }
            out["open"] = [self._public(t) for t in self.state["trades"] if t["status"] == "open"]
            out["today"] = [self._public(t) for t in self.state["trades"]]
            return out

    def _public(self, t):
        acc = self.accounts.get(t["account"])
        ltp = None
        if t["status"] == "open" and acc:
            try:
                ltp = acc.ltp(t["instrument"])
            except Exception:
                ltp = None
        d = {k: v for k, v in t.items() if k not in ("checks",)}
        if ltp is not None:
            d["ltp"] = ltp
            d["pnl"] = round((ltp - t["entryPrice"]) * t["qty"], 2)
            d["pnlPct"] = round((ltp / t["entryPrice"] - 1) * 100, 2) if t["entryPrice"] else None
        return d

    def positions(self, symbol):
        with self.lock:
            return {k: any(t["status"] == "open" and t["symbol"] == symbol and slot_of(t) == k for t in self.state["trades"])
                    for k, a in RULE_ACCOUNT.items() if a in self.accounts}

    # ---------- entries ----------
    def block_reason(self, account, symbol, now=None, entering=False, slot=None):
        """Why a new entry can't be sent, or '' (brief, Step 2 safety). entering: the check right before the BUY,
        made by the entry itself (its own in-progress mark is not a reason)."""
        now = now or self.clock()
        self._roll_day()
        if not self.state["auto"]:
            return "Auto is OFF"
        ok, why = self.accounts[account].available()
        if not ok:
            return why
        if self.state["halted"].get(account):
            return self.state["halted"][account]
        if self.state["unknown"].get(account):
            return f"Previous order status unknown: {self.state['unknown'][account]}"
        slot = slot or account
        if (slot, symbol) in self._busy and not entering:
            return "An order for this index is in progress"
        if self.positions(symbol).get(slot):
            return "Position already open on this index"
        trades = [t for t in self.state["trades"] if t["account"] == account]
        lim = self.cfg["limits"]
        if len(trades) >= lim["maxTradesPerDay"]:
            return self._halt(account, f"Daily limit reached: {lim['maxTradesPerDay']} trades")
        net = sum(t.get("netPnl") or 0 for t in trades if t["status"] == "closed")
        if net <= -lim["maxLossPerDay"]:
            return self._halt(account, f"Daily loss limit reached: Rs {-net:,.0f}")
        return ""

    def _halt(self, account, why):
        if self.state["halted"].get(account) != why:
            self.state["halted"][account] = why
            self._save()
            self.alert("limit", f"{ACCOUNT_NAMES[account]}: {why}. No more auto entries today.")
        return why

    def update_watch(self, symbol, expiry_hint, spot):
        """Keep the ATM options subscribed on the Trading Hub account (called every evaluation)."""
        acc = self.accounts.get(TH)
        if not acc or not spot:
            return
        try:
            exp = self._expiry(acc, symbol)
            self._watch[symbol] = acc.neighbours(symbol, exp, spot)
            ids = [i for v in self._watch.values() for i in v]
            open_ids = [t["instrument"]["id"] for t in self.state["trades"] if t["status"] == "open" and t["account"] == TH]
            acc.paper.watch(ids + open_ids + self.shadow_ids())
        except Exception as e:
            log.warning("could not subscribe ATM options for %s: %s", symbol, e)

    def _expiry(self, acc, symbol):
        exps = acc.expiries(symbol)
        if not exps:
            raise AccountError(f"No {symbol} expiries")
        today = self.clock().date().isoformat()
        if self.cfg.get("rollOnExpiryDay", True) and exps[0] == today and len(exps) > 1:
            return exps[1]
        return exps[0]

    def on_signal(self, result, state):
        """A rule result for one index (sig_rules). Starts an entry in the background when it is a GO."""
        slot = result["rule"]
        account = RULE_ACCOUNT.get(slot)
        if account not in self.accounts or not result["go"]:
            return ""
        if slot == D2 and not self.cfg.get(D2, {}).get("enabled", True):
            return "Dharani v2 is off (config dharaniV2.enabled)"
        why = self.block_reason(account, result["symbol"], slot=slot)
        if why:
            return why
        with self.lock:
            self._busy.add((slot, result["symbol"]))
        threading.Thread(target=self._enter, args=(account, result, state), name=f"entry-{account}", daemon=True).start()
        return "Entry sent"

    def _try(self, account, what, fn):
        """Runs fn; one retry. Two failures stop the account for the day (brief) and re-raise."""
        for attempt in (1, 2):
            try:
                return fn()
            except Exception as e:
                if attempt == 2:
                    self._halt(account, f"{what} failed twice: {e}")
                    raise
                log.warning("%s %s failed once: %s", account, what, e)
                time.sleep(1.5)

    def _enter(self, account, result, state):
        acc, symbol, side = self.accounts[account], result["symbol"], result["side"]
        slot = result["rule"]
        cfg = self.cfg[account]
        try:
            exp = self._try(account, "expiry list", lambda: self._expiry(acc, symbol))
            ref = state["spot"]
            if result.get("premiumNear"):  # Dharani v2: the strike whose premium is nearest the target (teacher: 250)
                ref = self._strike_by_premium(symbol, exp, side, result["premiumNear"]) or ref
            inst = self._try(account, "instrument lookup", lambda: acc.instrument(symbol, exp, ref, side))
            if account == TH:
                acc.paper.watch([i for v in self._watch.values() for i in v] + [inst["id"]] + self.shadow_ids())
                for _ in range(30):  # up to 15 s for the first price
                    if acc.ready(inst):
                        break
                    time.sleep(0.5)
                else:
                    raise AccountError(f"No live price for {inst['name']} yet")
            why = self.block_reason(account, symbol, entering=True, slot=slot)  # re-check right before sending
            if not why and any(t["status"] == "open" and t["account"] == account and t["instrument"]["id"] == inst["id"]
                               for t in self.state["trades"]):
                # another rule already holds this very option on this account: a second BUY would merge the two
                # positions (one stop / exit could close both), so this entry is skipped and logged
                why = f"{inst['name']} already held by another rule on this account"
                self.alert("info", f"{ACCOUNT_NAMES[account]} {symbol} {result.get('setup') or ''}: {why}; entry skipped.")
            if why:
                log.info("entry %s %s dropped: %s", account, symbol, why)
                return
            lots = int(cfg.get("lots", 1))
            self.state["unknown"][account] = f"entry {inst['name']}"
            entry_id, fill, qty = acc.buy(inst, lots)  # never retried: a second BUY could double the position
            self.state["unknown"].pop(account, None)
            stop = floor_tick(fill * (1 - cfg["stopPct"] / 100))
            # Dharani v2 has no fixed target: it exits when price closes back through SuperTrend (dharani_v2_exit)
            target = None if result.get("noTarget") else ceil_tick(fill * (1 + cfg["targetPct"] / 100))
            trade = {
                "id": f"{slot}-{symbol}-{self.clock():%H%M%S}", "account": account, "slot": slot, "symbol": symbol, "rule": result["name"],
                "setup": result.get("setup"), "grade": result.get("grade") or "n.a.", "side": side, "instrument": inst,
                "qty": qty, "lots": lots, "entryOrderId": entry_id, "entryTime": self.clock().strftime("%H:%M:%S"),
                "entryPrice": fill, "stop": stop, "target": target, "stopOrderId": None, "status": "open",
                "high": fill, "low": fill, "signalTime": result.get("at"),
                "spotAtEntry": state.get("spot"), "invested": round(fill * qty, 2),
                "rsi": _entry_rsi(state, side), "vix": state.get("vix"), "pcr": state.get("pcr"),
                "toiStrength": (state.get("toi") or [{}])[0].get("strengthPct"),
                "deltaStatus": "not checked", "tags": result.get("tags", []),
                "checks": {c["id"]: c["state"] == PASS for c in result["checks"]},
                "checkStates": {c["id"]: c["state"] for c in result["checks"]},
            }
            with self.lock:
                self.state["trades"].append(trade)
                self._save()
            self.on_order(trade, "entry")
            try:
                trade["stopOrderId"] = self._try(account, "stop order", lambda: acc.stop(inst, lots, qty, stop))
            except Exception:
                self.alert("api", f"{ACCOUNT_NAMES[account]} {symbol}: stop order failed twice; exiting the position.")
                self._exit(trade, "Stop order failed")
                return
            with self.lock:
                self._save()
            self.on_order(trade, "stop placed")
        except Exception as e:
            log.exception("entry failed")
            self.alert("api", f"{ACCOUNT_NAMES[account]} {symbol} entry failed: {e}")
            if not self.state["halted"].get(account):
                self._halt(account, f"Entry failed: {e}")
        finally:
            with self.lock:
                self._busy.discard((slot, symbol))
                self._save()

    # ---------- exits ----------
    # ---------- shadow logging (record only: never places or changes an order) ----------
    def shadow_ids(self):
        return [sh["dhanId"] for sh in self.state.get("shadows", []) if sh.get("dhanId") and not sh.get("done")]

    def _dhan_option(self, symbol, expiry, strike, side):
        """The Dhan security ID of an option (shadows always read Dhan's live premium, whichever account traded)."""
        acc = self.accounts.get(TH)
        if not acc:
            return None
        for r in acc.paper.instrument_chain(symbol, expiry):
            if abs(r["strike"] - strike) < 1e-6 and r[side.lower()]:
                return r[side.lower()]["securityId"]
        return None

    def _premium(self, dhan_id):
        acc = self.accounts.get(TH)
        try:
            return acc.paper.ltp(dhan_id) if acc and dhan_id else None
        except Exception:
            return None

    def _start_exit_shadow(self, trade):
        inst = trade["instrument"]
        dhan_id = inst["id"] if trade["account"] == TH else self._dhan_option(trade["symbol"], inst["expiry"], inst["strike"], inst["optionType"])
        with self.lock:
            self.state["shadows"].append({
                "kind": "exit", "tradeId": trade["id"], "symbol": trade["symbol"], "side": trade["side"], "dhanId": dhan_id,
                "high": None, "highTime": None, "low": None, "at1515": None, "spot1515": None, "trendHeld": None,
                "until": SHADOW_EXIT_UNTIL, "done": False,
            })
            self._save()
        self._refresh_watch()

    def add_skip(self, result, state, missed, why):
        """A setup the rule skipped (docs: owner's brief 7b). Tracks the ATM option that WOULD have been bought."""
        symbol, side, rule = result["symbol"], result["side"], result.get("setup") or "Trend"
        now = self.clock()
        self._roll_day()
        if now.strftime("%H:%M") >= SHADOW_SKIP_UNTIL:
            return
        for sh in self.state["shadows"]:
            if sh["kind"] == "skip" and sh["rule"] == rule and sh["symbol"] == symbol and sh["side"] == side \
                    and (now - datetime.fromisoformat(sh["createdAt"])).total_seconds() < SKIP_REPEAT_MINUTES * 60:
                return
        acc = self.accounts.get(TH)
        if not acc:
            return
        try:
            exp = self._expiry(acc, symbol)
            inst = acc.instrument(symbol, exp, state["spot"], side)
        except Exception as e:
            log.warning("shadow skip %s %s: no instrument: %s", symbol, side, e)
            inst = None
        pct = self.cfg[RULE_ACCOUNT.get(result["rule"], TH)]
        with self.lock:
            self.state["shadows"].append({
                "kind": "skip", "createdAt": now.isoformat(), "symbol": symbol, "side": side, "rule": rule,
                "candle": result.get("at"), "missed": missed, "why": why, "dhanId": inst["id"] if inst else None,
                "instrument": inst["name"] if inst else "", "stopPct": pct["stopPct"], "targetPct": pct["targetPct"],
                "ref": None, "high": None, "highTime": None, "low": None, "lowTime": None, "targetTime": None, "stopTime": None,
                "until": SHADOW_SKIP_UNTIL, "done": False,
            })
            self._save()
        self._refresh_watch()

    def _refresh_watch(self):
        acc = self.accounts.get(TH)
        if acc:
            ids = [i for v in self._watch.values() for i in v]
            open_ids = [t["instrument"]["id"] for t in self.state["trades"] if t["status"] == "open" and t["account"] == TH]
            try:
                acc.paper.watch(ids + open_ids + self.shadow_ids())
            except Exception:
                pass

    def _shadow_tick(self, now):
        hm = now.strftime("%H:%M:%S")
        for sh in self.state.get("shadows", []):
            if sh["done"]:
                continue
            if hm >= sh["until"] + ":00":
                sh["done"] = True
                continue
            p = self._premium(sh["dhanId"])
            if not p:
                continue
            t = now.strftime("%H:%M")
            if sh["kind"] == "skip" and sh["ref"] is None:
                sh["ref"] = p  # the premium the entry would have paid (first price after the next candle opened)
                sh["stopLevel"] = floor_tick(p * (1 - sh["stopPct"] / 100))
                sh["targetLevel"] = ceil_tick(p * (1 + sh["targetPct"] / 100))
            if sh["high"] is None or p > sh["high"]:
                sh["high"], sh["highTime"] = p, t
            if sh["low"] is None or p < sh["low"]:
                sh["low"], sh["lowTime"] = p, t
            if sh["kind"] == "skip":
                if sh["targetTime"] is None and sh["stopTime"] is None:
                    if p >= sh["targetLevel"]:
                        sh["targetTime"] = t
                    elif p <= sh["stopLevel"]:
                        sh["stopTime"] = t
            if sh["kind"] == "exit" and sh["at1515"] is None and hm >= "15:15:00":
                sh["at1515"] = p
                st = self._last_state.get(sh["symbol"])
                if st:
                    sh["spot1515"] = st.get("spot")
                    d = st["ind"]["st_dir"][st["i"]]
                    sh["trendHeld"] = "Y" if (d == 1 and sh["side"] == "PE") or (d == -1 and sh["side"] == "CE") else "N"

    def shadow_summary(self):
        skips = [sh for sh in self.state.get("shadows", []) if sh["kind"] == "skip"]
        worked = sum(1 for sh in skips if self._skip_verdict(sh)[0] == "Y")
        return {"skipped": len(skips), "wouldHaveWorked": worked}

    @staticmethod
    def _skip_verdict(sh):
        if sh.get("ref") is None:
            return "Unclear", "Unclear"
        if sh.get("targetTime"):
            return "Y", "Wrong"
        return "N", "Right"

    def finish_day(self):
        """After 15:30: shadow_skips CSV rows and the post-exit columns in today's trade log rows. Once per day."""
        self._roll_day()
        if self.state["finished"] == self.state["day"]:
            return
        day = self.state["day"]
        rows = []
        for sh in [x for x in self.state["shadows"] if x["kind"] == "skip"]:
            worked, verdict = self._skip_verdict(sh)
            if sh.get("ref") is None:
                nxt = "No premium data for the option."
            else:
                pct = lambda v: f"{(v / sh['ref'] - 1) * 100:+.1f}%"  # noqa: E731
                nxt = (f"High {sh['high']} at {sh['highTime']} ({pct(sh['high'])}), low {sh['low']} at {sh['lowTime']} ({pct(sh['low'])}); "
                       + (f"target first at {sh['targetTime']}" if sh["targetTime"] else f"stop first at {sh['stopTime']}" if sh["stopTime"] else "neither by 15:15"))
            rows.append({
                "date": day, "index": sh["symbol"], "candle_time": sh["candle"], "setup": "call" if sh["side"] == "CE" else "put",
                "rule": sh["rule"], "filters_missed": sh["missed"], "why_skipped": sh["why"], "instrument": sh["instrument"],
                "reference_premium": sh.get("ref"), "stop_level": sh.get("stopLevel"), "target_level": sh.get("targetLevel"),
                "highest_premium": sh["high"], "time_of_high": sh["highTime"], "lowest_premium": sh["low"], "time_of_low": sh["lowTime"],
                "target_reached": "Y" if sh["targetTime"] else "N", "target_time": sh["targetTime"],
                "stop_hit_first": "Y" if sh["stopTime"] else "N", "stop_time": sh["stopTime"],
                "what_happened_next": nxt, "would_it_have_worked": worked, "skip_verdict": verdict,
            })
        if rows:
            self._append_csv(os.path.join(self.cfg["logDir"], "shadow_skips.csv"), SHADOW_SKIP_FIELDS, rows)
        self._rewrite_trade_log()
        self.state["finished"] = day
        self._save()

    def _append_csv(self, path, fields, rows):
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            new = not os.path.exists(path)
            with open(path, "a", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=fields)
                if new:
                    w.writeheader()
                w.writerows(rows)
        except OSError as e:
            self.alert("log", f"Could not write {path}: {e}")

    def _rewrite_trade_log(self):
        """Today's rows get the shadow-after-exit columns (the rows of other days are kept as they are)."""
        path = os.path.join(self.cfg["logDir"], "trade_log.csv")
        try:
            old = list(csv.DictReader(open(path, encoding="utf-8"))) if os.path.exists(path) else []
        except OSError:
            return
        keep = [r for r in old if r.get("date") != self.state["day"]]
        today = [self._log_row(t) for t in self.state["trades"] if t["status"] == "closed"]
        try:
            with open(path, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=TRADE_LOG_FIELDS, extrasaction="ignore")
                w.writeheader()
                w.writerows(keep + today)
        except OSError as e:
            self.alert("log", f"Could not update the trade log ({path}): {e}")

    def on_candle(self, symbol, state):
        """Signal exit check on a completed 5-minute candle (Trading Hub rule only)."""
        self._last_state[symbol] = state
        for t in list(self.state["trades"]):
            if t["status"] == "open" and t["symbol"] == symbol and t["account"] == TH:
                why = trading_hub_exit(state, t["side"])
                if why:
                    threading.Thread(target=self._exit, args=(t, "Signal", why), daemon=True).start()

    def _strike_by_premium(self, symbol, expiry, side, target):
        """Strike whose last traded premium is nearest `target`, from Dhan's option chain (chain_source is set by the
        signal service). None if the chain can't be read: the caller falls back to ATM."""
        src = getattr(self, "chain_source", None)
        if src is None:
            return None
        try:
            rows = src.chain(symbol, expiry)["rows"]
        except Exception as e:
            log.warning("premium-near strike %s %s: %s", symbol, expiry, e)
            return None
        legs = [(r["strike"], (r.get(side.lower()) or {}).get("last_price")) for r in rows]
        legs = [(k, p) for k, p in legs if p]
        if not legs:
            return None
        return min(legs, key=lambda x: (abs(x[1] - target), x[0]))[0]

    def on_candle_v2(self, symbol, state):
        """Dharani v2 exit check on a completed 3-minute candle: price closed back through SuperTrend."""
        from sig_dharani_v2 import dharani_v2_exit
        for t in list(self.state["trades"]):
            if t["status"] == "open" and t["symbol"] == symbol and slot_of(t) == D2:
                why = dharani_v2_exit(state, t["side"])
                if why:
                    threading.Thread(target=self._exit, args=(t, "Signal", why), daemon=True).start()

    def _exit(self, trade, reason, note=""):
        acc = self.accounts[trade["account"]]
        key = (slot_of(trade), trade["symbol"])
        with self.lock:
            if trade["status"] != "open" or trade.get("exiting"):
                return
            trade["exiting"] = True
            self._busy.add(key)
        try:
            if trade.get("stopOrderId"):
                st = acc.order(trade["stopOrderId"])
                if st and st["status"] == "FILLED":  # the stop got there first
                    self._close(trade, "Stop", st["avgPrice"])
                    return
                self._try(trade["account"], "cancel stop", lambda: acc.cancel(trade["stopOrderId"]))
            qty = acc.position_qty(trade["instrument"])
            if qty == 0:  # already flat (platform square-off or a manual exit)
                self._close(trade, reason, acc.last_sell_price(trade["instrument"]))
                return
            oid, price = self._try(trade["account"], "exit order", lambda: acc.sell(trade["instrument"], trade["lots"], trade["qty"]))
            trade["exitOrderId"] = oid
            self._close(trade, reason, price, note)
        except Exception as e:
            log.exception("exit failed")
            self.alert("api", f"{ACCOUNT_NAMES[trade['account']]} {trade['symbol']} exit failed: {e}. Check the position by hand.")
        finally:
            with self.lock:
                trade.pop("exiting", None)
                self._busy.discard(key)
                self._save()

    def _close(self, trade, reason, price, note=""):
        acc = self.accounts[trade["account"]]
        with self.lock:
            trade.update(status="closed", exitReason=reason, exitNote=note, exitTime=self.clock().strftime("%H:%M:%S"), exitPrice=price)
            if price is not None:
                trade["high"], trade["low"] = max(trade["high"], price), min(trade["low"], price)
                trade["grossPnl"] = round((price - trade["entryPrice"]) * trade["qty"], 2)
                try:
                    trade["charges"] = acc.charges(trade)
                except Exception:
                    trade["charges"] = None
                trade["netPnl"] = round(trade["grossPnl"] - (trade["charges"] or 0), 2)
            self._save()
        self._write_log(trade)
        self.on_order(trade, f"exit {reason}")
        try:
            self._start_exit_shadow(trade)
        except Exception:
            log.exception("could not start the post-exit shadow")

    def tick(self):
        """Every ~2 s: highest / lowest premium, target, stop fills, the time exit."""
        now = self.clock()
        self._roll_day()
        self._shadow_tick(now)
        cutoff = datetime.strptime(self.cfg.get("timeExit", "15:14"), "%H:%M").time()
        for t in [t for t in self.state["trades"] if t["status"] == "open" and not t.get("exiting")]:
            acc = self.accounts[t["account"]]
            if now.time() >= cutoff:
                threading.Thread(target=self._exit, args=(t, "Time"), daemon=True).start()
                continue
            try:
                ltp = acc.ltp(t["instrument"])
            except Exception:
                ltp = None
            if ltp:
                t["high"], t["low"] = max(t["high"], ltp), min(t["low"], ltp)
                if t["target"] is not None and ltp >= t["target"]:
                    threading.Thread(target=self._exit, args=(t, "Target"), daemon=True).start()
                    continue
            poll = 2 if t["account"] == TH else 10
            if t.get("stopOrderId") and time.monotonic() - self._last_stop_poll.get(t["id"], 0) >= poll:
                self._last_stop_poll[t["id"]] = time.monotonic()
                try:
                    st = acc.order(t["stopOrderId"])
                except Exception:
                    st = None
                if st and st["status"] == "FILLED":
                    t["exitOrderId"] = t["stopOrderId"]
                    self._close(t, "Stop", st["avgPrice"])
                elif t["account"] == TH and acc.position_qty(t["instrument"]) == 0:
                    self._close(t, "Time" if now.time() >= cutoff else "Manual", acc.last_sell_price(t["instrument"]))

    def start(self):
        def run():
            while not self._stop_evt.wait(2.0):
                try:
                    self.tick()
                except Exception:
                    log.exception("auto paper tick failed")
        self._thread = threading.Thread(target=run, name="autopaper", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_evt.set()

    # ---------- manual bracket (dashboard button "Place stop + target together") ----------
    def bracket(self, security_id, stop_pct=None, target_pct=None):
        """Attach a stop and a target to an open Trading Hub paper position the owner bought by hand. Tracked like an
        auto trade (stop pending, target watched), logged with rule "Manual"."""
        acc = self.accounts[TH]
        inst_raw = acc.paper.instruments.get(security_id)
        if not inst_raw:
            raise AccountError(f"{security_id} is not a NIFTY / BANKNIFTY option")
        qty = acc.paper.open_qty(security_id)
        if qty <= 0:
            raise AccountError("No open position in this option")
        if any(t["status"] == "open" and t["instrument"]["id"] == security_id for t in self.state["trades"]):
            raise AccountError("This position already has a stop and target")
        pos = next(p for p in acc.paper.positions() if p["security_id"] == security_id)
        fill = pos["avg_buy"]
        cfg = self.cfg[TH]
        sp, tp = stop_pct or cfg["stopPct"], target_pct or cfg["targetPct"]
        inst = {"id": security_id, "name": inst_raw["name"], "strike": inst_raw["strike"], "expiry": inst_raw["expiry"],
                "optionType": inst_raw["optionType"], "lotSize": inst_raw["lotSize"]}
        lots = qty // inst["lotSize"]
        trade = {
            "id": f"manual-{security_id}-{self.clock():%H%M%S}", "account": TH, "symbol": inst_raw["symbol"], "rule": "Manual",
            "setup": None, "grade": "n.a.", "side": inst["optionType"], "instrument": inst, "qty": qty, "lots": lots,
            "entryOrderId": None, "entryTime": self.clock().strftime("%H:%M:%S"), "entryPrice": round(fill, 2),
            "stop": floor_tick(fill * (1 - sp / 100)), "target": ceil_tick(fill * (1 + tp / 100)), "stopOrderId": None,
            "status": "open", "high": fill, "low": fill, "deltaStatus": "not checked", "tags": ["manual"], "checks": {},
            "spotAtEntry": None, "invested": round(fill * qty, 2),
        }
        trade["stopOrderId"] = acc.stop(inst, lots, qty, trade["stop"])
        with self.lock:
            self.state["trades"].append(trade)
            self._save()
        self.on_order(trade, "bracket")
        return self._public(trade)

    def account_orders(self, account):
        """That account's orders today (the "Open order book" button). MegaBull's come from its API."""
        acc = self.accounts.get(account)
        if not acc:
            raise AccountError("Unknown account")
        if account == MB:
            ok, why = acc.available()
            if not ok:
                raise AccountError(why)
            return acc.client.orders()
        return acc.paper.orders()

    def exit_trade(self, trade_id):
        t = next((t for t in self.state["trades"] if t["id"] == trade_id and t["status"] == "open"), None)
        if not t:
            raise AccountError("No open auto trade with that id")
        self._exit(t, "Manual")

    # ---------- trade log ----------
    def _log_row(self, t):
        sh = next((x for x in self.state.get("shadows", []) if x["kind"] == "exit" and x.get("tradeId") == t["id"]), {})
        missed = None
        if sh.get("high") is not None and t.get("exitPrice") is not None and t["entryPrice"]:
            missed = round((sh["high"] - t["exitPrice"]) / t["entryPrice"] * 100, 2)
        return {
            "date": self.state["day"], "index": t["symbol"], "account": ACCOUNT_NAMES[t["account"]],
            "rule": f"{t['rule']} ({t['setup']})" if t.get("setup") else t["rule"],
            "grade": t["grade"], "side": t["side"], "instrument": t["instrument"]["name"], "entry_time": t["entryTime"],
            "entry_price": t["entryPrice"], "qty": t["qty"], "stop": t["stop"], "target": t["target"] if t["target"] is not None else "SuperTrend exit",
            "exit_time": t.get("exitTime"), "exit_price": t.get("exitPrice"), "exit_reason": t.get("exitReason"),
            "gross_pnl": t.get("grossPnl"), "charges": t.get("charges"), "net_pnl": t.get("netPnl"),
            "highest_premium": t["high"], "lowest_premium": t["low"],
            "rsi_at_entry": None if t.get("rsi") is None else round(t["rsi"], 2), "vix": t.get("vix"),
            "pcr": None if t.get("pcr") is None else round(t["pcr"], 2), "trending_oi_strength": t.get("toiStrength"),
            "delta_status": t.get("deltaStatus"),
            "checks": "; ".join(f"{k}={'true' if v else 'false'}" for k, v in (t.get("checks") or {}).items()),
            "highest_premium_after_exit": sh.get("high"), "time_of_high_after_exit": sh.get("highTime"),
            "lowest_premium_after_exit": sh.get("low"), "premium_at_1515": sh.get("at1515"), "spot_at_1515": sh.get("spot1515"),
            "trend_still_held_at_1515": sh.get("trendHeld"), "missed_profit_pct_of_entry": missed,
        }

    def _write_log(self, t):
        self._append_csv(os.path.join(self.cfg["logDir"], "trade_log.csv"), TRADE_LOG_FIELDS, [self._log_row(t)])
