"""
last_trades.py - the real last traded price of option legs that have not traded today, for GET /api/option-chain.

Why: for a leg with no trade today (volume 0) Dhan's option chain sends `last_price` = `previous_close_price`, which is
not a trade. Checked 29-Oct-2026, SENSEX 5 Nov:
  76,900 CE  chain last_price 120 = previous_close_price 120, OI 80, volume 0;
             quote API (/marketfeed/quote, the feed's data) last_price 4.75, last_trade_time "29/10/2026 00:00:00".
  77,200 CE  chain last_price 548.5 = previous_close_price, OI 0, volume 0; quote last_price 0 (never traded).
  77,000 CE  chain last_price 18.3 = quote 18.3 (traded today, volume 757,700): the chain is right when it traded.

So every leg of the answer gets `traded_today` (volume > 0). A leg that hasn't traded today takes its `last_price`
from the quote API (0 when it has never traded, or when the quote call failed: then `last_price_unknown`), keeps
Dhan's chain value in `chain_last_price`, and carries `last_trade_time` (Dhan's text; "dd/mm/yyyy 00:00:00" = an
earlier session). The cached chain itself is not changed: the Trending OI tracker records it exactly as Dhan sent it.
One quote call per fresh chain (it is reused until the chain is fetched again), up to 1000 legs per call.
"""
import copy
import logging
import threading

from dhan_client import DhanError

log = logging.getLogger("last_trades")

QUOTE_BATCH = 1000  # Dhan's market quote: up to 1000 instruments per request
OPTION_SEGMENT = {"SENSEX": "BSE_FNO"}  # options of other indices: NSE_FNO


def correct_rows(rows, quotes):
    """rows: chain_cache.strike_rows (not changed). quotes: {security_id: {"ltp", "time"}} for the legs that haven't
    traded today, or None when the quote call failed. Returns corrected copies."""
    out = copy.deepcopy(rows)
    for r in out:
        for leg in (r["ce"], r["pe"]):
            if not leg:
                continue
            traded = float(leg.get("volume") or 0) > 0
            leg["traded_today"] = traded
            if traded:
                continue
            leg["chain_last_price"] = leg.get("last_price")
            q = None if quotes is None else quotes.get(int(leg.get("security_id") or 0))
            leg["last_price"] = float(q["ltp"]) if q else 0.0
            leg["last_trade_time"] = q.get("time") if q else None
            if quotes is None:
                leg["last_price_unknown"] = True
    return out


def no_trade_ids(rows):
    return [int(l["security_id"]) for r in rows for l in (r["ce"], r["pe"])
            if l and l.get("security_id") and not float(l.get("volume") or 0) > 0]


class LastTrades:
    """Corrected rows per (symbol, expiry), kept until the cached chain is fetched again."""

    def __init__(self, client):
        self.client = client
        self._lock = threading.Lock()
        self._done = {}  # (symbol, expiry) -> (chain fetched_at, corrected rows)

    def rows(self, symbol, expiry, entry, rows):
        key = (symbol, expiry)
        with self._lock:
            hit = self._done.get(key)
        if hit and hit[0] == entry.fetched_at:
            return hit[1]
        ids = no_trade_ids(rows)
        quotes = {}
        if ids and hasattr(self.client, "last_trades"):
            try:
                seg = OPTION_SEGMENT.get(symbol, "NSE_FNO")
                for i in range(0, len(ids), QUOTE_BATCH):
                    quotes.update(self.client.last_trades(seg, ids[i:i + QUOTE_BATCH]))
            except DhanError as e:
                log.warning("last traded prices for %s %s: %s", symbol, expiry, e)
                quotes = None  # show no price rather than the chain's previous close
        fixed = correct_rows(rows, quotes)
        if quotes is not None:  # a failed quote call is tried again on the next request
            with self._lock:
                self._done[key] = (entry.fetched_at, fixed)
        return fixed
