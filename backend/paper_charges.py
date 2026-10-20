"""
paper_charges.py - brokerage and statutory charges for paper trades in NSE index options (intraday).

Every rate lives here, with its source and date. When NSE, SEBI or the government revise a rate, change it here
and re-check a few trades against Dhan's brokerage calculator (see test_paper_charges.py).

Each component is rounded to the paisa (half up). GST is charged on the rounded brokerage + transaction + SEBI
amounts, as they appear on a contract note.
"""
from dataclasses import asdict, dataclass
from decimal import ROUND_HALF_UP, Decimal

BROKERAGE_PER_ORDER = 20.0  # Dhan: flat Rs 20 per executed F&O order
STT_SELL_RATE = 0.0015      # 0.15% of sell premium from 1-Apr-2026 (Union Budget 2026; was 0.1% before)
NSE_TXN_RATE = 0.0003503    # Rs 35.03 per lakh of premium, NSE flat fee from 1-Oct-2024
                            # (re-check against NSE circular FA/73061, 27-Feb-2026, which revised IPFT contributions)
SEBI_RATE = 10 / 1e7        # Rs 10 per crore of turnover
STAMP_BUY_RATE = 0.00003    # 0.003% of buy premium
GST_RATE = 0.18             # on brokerage + transaction + SEBI


def r2(x):
    """Round money to the paisa, half up (avoids float artefacts such as round(0.225, 2))."""
    return float(Decimal(repr(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


@dataclass(frozen=True)
class Charges:
    brokerage: float
    stt: float
    transaction: float
    sebi: float
    stamp: float
    gst: float

    @property
    def total(self):
        return r2(self.brokerage + self.stt + self.transaction + self.sebi + self.stamp + self.gst)

    def to_dict(self):
        return {**asdict(self), "total": self.total}


def order_charges(side, premium_value):
    """Charges for one executed order. premium_value = average fill price x quantity in units."""
    if side not in ("BUY", "SELL"):
        raise ValueError(f"side must be BUY or SELL, not {side!r}")
    if premium_value < 0:
        raise ValueError("premium_value cannot be negative")
    brokerage = r2(BROKERAGE_PER_ORDER)
    transaction = r2(premium_value * NSE_TXN_RATE)
    sebi = r2(premium_value * SEBI_RATE)
    return Charges(
        brokerage=brokerage,
        stt=r2(premium_value * STT_SELL_RATE) if side == "SELL" else 0.0,
        transaction=transaction,
        sebi=sebi,
        stamp=r2(premium_value * STAMP_BUY_RATE) if side == "BUY" else 0.0,
        gst=r2((brokerage + transaction + sebi) * GST_RATE),
    )
