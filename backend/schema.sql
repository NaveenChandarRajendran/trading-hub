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

-- Paper trading (simulation only). Prefixed pt_. Quantities in units (lots x lot size), money in rupees.
CREATE TABLE IF NOT EXISTS pt_accounts (
    id           serial           PRIMARY KEY,
    capital      double precision NOT NULL,           -- starting virtual capital
    created_at   timestamptz      NOT NULL DEFAULT now(),
    archived_at  timestamptz                          -- set by "Reset account"; history stays queryable
);

CREATE TABLE IF NOT EXISTS pt_orders (
    account_id      integer          NOT NULL REFERENCES pt_accounts(id),
    id              text             NOT NULL,        -- PT20261021-0001
    trade_date      date             NOT NULL,        -- IST trading day
    security_id     bigint           NOT NULL,
    side            text             NOT NULL,        -- BUY | SELL
    order_type      text             NOT NULL,        -- MARKET | LIMIT | SL | SL-M
    lots            integer          NOT NULL,
    lot_size        integer          NOT NULL,
    price           double precision,
    trigger_price   double precision,
    status          text             NOT NULL,        -- PENDING | TRIGGERED | FILLED | CANCELLED | REJECTED
    avg_price       double precision,
    slippage_capped boolean          NOT NULL DEFAULT false,
    reason          text             NOT NULL DEFAULT '',
    blocked         double precision NOT NULL DEFAULT 0,
    created_at      timestamptz      NOT NULL,
    updated_at      timestamptz      NOT NULL,
    filled_at       timestamptz,
    PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS pt_trades (                -- one row per fill
    account_id   integer          NOT NULL REFERENCES pt_accounts(id),
    id           text             NOT NULL,           -- TR20261021-0001
    order_id     text             NOT NULL,
    trade_date   date             NOT NULL,
    security_id  bigint           NOT NULL,
    side         text             NOT NULL,
    qty          integer          NOT NULL,
    price        double precision NOT NULL,           -- average fill price
    value        double precision NOT NULL,           -- price x qty
    brokerage    double precision NOT NULL,
    stt          double precision NOT NULL,
    transaction  double precision NOT NULL,
    sebi         double precision NOT NULL,
    stamp        double precision NOT NULL,
    gst          double precision NOT NULL,
    traded_at    timestamptz      NOT NULL,
    PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS pt_positions (             -- day position per instrument, for the P&L report
    account_id   integer          NOT NULL REFERENCES pt_accounts(id),
    trade_date   date             NOT NULL,
    security_id  bigint           NOT NULL,
    lot_size     integer          NOT NULL,
    buy_qty      integer          NOT NULL,
    sell_qty     integer          NOT NULL,
    avg_buy      double precision NOT NULL,
    avg_sell     double precision NOT NULL,
    realized     double precision NOT NULL,
    PRIMARY KEY (account_id, trade_date, security_id)
);
