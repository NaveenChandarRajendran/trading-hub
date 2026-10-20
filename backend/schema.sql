-- Trending OI tables. Created automatically on startup (CREATE IF NOT EXISTS); kept here so you can read them.
-- All tables are prefixed toi_, so they can live in an existing database (e.g. algo_trading) without clashes.

-- One row per (index, expiry, trading day): the 15 strikes fixed at the day's first snapshot.
CREATE TABLE IF NOT EXISTS toi_session (
    symbol      text             NOT NULL,
    expiry      text             NOT NULL,            -- 'YYYY-MM-DD' as Dhan returns it
    trade_date  date             NOT NULL,            -- IST trading day
    strikes     double precision[] NOT NULL,
    created_at  timestamptz      NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol, expiry, trade_date)
);

-- One row per minute per (index, expiry): the totals over the fixed strikes. 5/15-min views are filters of this.
CREATE TABLE IF NOT EXISTS toi_snapshot (
    symbol        text             NOT NULL,
    expiry        text             NOT NULL,
    ts            timestamptz      NOT NULL,          -- the minute, e.g. 2026-10-21 09:20+05:30
    spot          double precision NOT NULL,
    strikes_used  integer          NOT NULL,
    call_chg      double precision NOT NULL,          -- sum(CE oi - previous_oi), units
    put_chg       double precision NOT NULL,
    call_ltp      double precision NOT NULL,
    put_ltp       double precision NOT NULL,
    call_ltp_chg  double precision NOT NULL,
    put_ltp_chg   double precision NOT NULL,
    PRIMARY KEY (symbol, expiry, ts)
);
