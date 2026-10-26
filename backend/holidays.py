"""
NSE equity/F&O trading holidays that fall on weekdays (2026), as listed in public NSE holiday lists.
Please check them against NSE's official circular and edit this file when NSE adds or changes a date.
On these days the backend records nothing (Dhan would only return the previous session's data).
"""
NSE_HOLIDAYS = {
    "2026-01-15", "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03",
    "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02",
    "2026-10-20",  # Dussehra
    "2026-11-10", "2026-11-24", "2026-12-25",
}


def is_trading_day(d):
    """d = datetime.date. Weekday and not in NSE_HOLIDAYS (special sessions are not covered)."""
    return d.weekday() < 5 and d.isoformat() not in NSE_HOLIDAYS


def next_trading_day(d):
    from datetime import timedelta
    n = d + timedelta(days=1)
    while not is_trading_day(n):
        n += timedelta(days=1)
    return n
