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

-- OI support / resistance level history (sr_levels.py): a row per level per time it was in effect.
-- Written only when a slot's strike changes; the old row gets its valid_to. Times are minutes (IST).
CREATE TABLE IF NOT EXISTS sr_levels (
    symbol      text             NOT NULL,
    expiry      text             NOT NULL,
    trade_date  date             NOT NULL,            -- IST trading day
    slot        text             NOT NULL,            -- R1 R2 R3 S1 S2 S3
    strike      double precision NOT NULL,
    oi          double precision NOT NULL,            -- units, when the level took effect
    valid_from  timestamptz      NOT NULL,
    valid_to    timestamptz,                          -- NULL while it is the current level
    reason      text             NOT NULL,            -- open | oi | crossed | range | fill | renumber
    PRIMARY KEY (symbol, expiry, slot, valid_from)
);

-- Stability rule settings shared by every browser (one row).
CREATE TABLE IF NOT EXISTS sr_settings (
    id          integer          PRIMARY KEY DEFAULT 1,
    settings    jsonb            NOT NULL
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

CREATE TABLE IF NOT EXISTS pt_order_levels (         -- the S/R levels at order time (paper_levels.py)
    account_id   integer          NOT NULL REFERENCES pt_accounts(id),
    order_id     text             NOT NULL,
    trade_date   date             NOT NULL,
    symbol       text             NOT NULL,
    expiry       date             NOT NULL,           -- the expiry whose levels were used
    spot         double precision NOT NULL,
    levels_at    text             NOT NULL,           -- 'YYYY-MM-DD HH:MM' IST, the level refresh used
    levels       jsonb            NOT NULL,           -- {"R1": 23000, ..., "S3": 22600}
    zone_slot    text,                                -- entry zone: the level nearest spot
    zone_strike  double precision,
    created_at   timestamptz      NOT NULL,
    PRIMARY KEY (account_id, order_id)
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

-- Accounts by name: NULL = the manual Paper Trading account, 'Algo' = the OI breakout algo's (algo_service.py).
ALTER TABLE pt_accounts ADD COLUMN IF NOT EXISTS name text;
-- Who placed an order: 'manual' (the page) or 'algo' (+ the setup, e.g. 'Breakout CE').
ALTER TABLE pt_orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE pt_orders ADD COLUMN IF NOT EXISTS setup text NOT NULL DEFAULT '';

-- Which variant placed an algo order (A-D; '' for manual orders).
ALTER TABLE pt_orders ADD COLUMN IF NOT EXISTS variant text NOT NULL DEFAULT '';
-- Target + stop of one position placed as an OCO pair (paper_engine.set_protection); '' for every other order.
ALTER TABLE pt_orders ADD COLUMN IF NOT EXISTS oco_group text NOT NULL DEFAULT '';
-- Trailing stop on the OCO stop leg (paper_engine.set_trail): points below the high, step, start-after profit, high.
ALTER TABLE pt_orders ADD COLUMN IF NOT EXISTS trail_distance double precision;
ALTER TABLE pt_orders ADD COLUMN IF NOT EXISTS trail_step double precision;
ALTER TABLE pt_orders ADD COLUMN IF NOT EXISTS trail_after double precision;
ALTER TABLE pt_orders ADD COLUMN IF NOT EXISTS trail_high double precision;

-- ================================================================ OI breakout algo (algo_service.py)
-- Every date column is the IST trading date written by the app (never derived from UTC timestamps).
-- Decision log: one row per signal / skip / entry / exit / error / heartbeat / feed / levels / info line.
CREATE TABLE IF NOT EXISTS algo_events (
    id          bigserial   PRIMARY KEY,
    trade_date  date        NOT NULL,
    ts          timestamptz NOT NULL,
    "index"     text        NOT NULL,       -- NIFTY | BANKNIFTY | * (both)
    variant     text        NOT NULL DEFAULT 'A',
    type        text        NOT NULL,       -- signal | skip | entry | exit | error | heartbeat | feed | levels | info
    setup       text        NOT NULL DEFAULT '',
    message     text        NOT NULL,
    details     jsonb       NOT NULL DEFAULT '{}',  -- kind (fine-grained), spot, levels, filter values, trade
    uid         text                        -- md5 of ts|index|variant|type|setup|message: imports never duplicate
);
-- migration from the 23-Oct layout (at, symbol, kind, data; no variant): rename in place, keep every row
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'algo_events' AND column_name = 'at') THEN
        ALTER TABLE algo_events RENAME COLUMN at TO ts;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'algo_events' AND column_name = 'symbol') THEN
        ALTER TABLE algo_events RENAME COLUMN symbol TO "index";
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'algo_events' AND column_name = 'kind') THEN
        ALTER TABLE algo_events RENAME COLUMN kind TO type;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'algo_events' AND column_name = 'data') THEN
        ALTER TABLE algo_events RENAME COLUMN data TO details;
    END IF;
END $$;
ALTER TABLE algo_events ADD COLUMN IF NOT EXISTS variant text NOT NULL DEFAULT 'A';
ALTER TABLE algo_events ADD COLUMN IF NOT EXISTS uid text;
-- old fine-grained kinds -> type (the kind stays in details.kind)
UPDATE algo_events SET details = details || jsonb_build_object('kind', type) WHERE NOT details ? 'kind';
UPDATE algo_events SET type = CASE type WHEN 'armed' THEN 'signal' WHEN 'cancel' THEN 'signal' WHEN 'expire' THEN 'signal'
                                        WHEN 'stale' THEN 'feed' ELSE type END
    WHERE type IN ('armed', 'cancel', 'expire', 'stale');
UPDATE algo_events SET uid = md5(concat_ws('|', to_char(ts AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS'),
                                           "index", variant, type, setup, message))
    WHERE uid IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS algo_events_uid ON algo_events (uid);
CREATE INDEX IF NOT EXISTS algo_events_day ON algo_events (trade_date, id);
CREATE INDEX IF NOT EXISTS algo_events_day_index ON algo_events (trade_date, "index");
CREATE INDEX IF NOT EXISTS algo_events_day_variant ON algo_events (trade_date, variant);

-- Per index and variant (live + shadows): locked levels, setups, open trade, trade count, closed trades.
CREATE TABLE IF NOT EXISTS algo_state (
    trade_date  date        NOT NULL,
    "index"     text        NOT NULL,
    variant     text        NOT NULL DEFAULT 'A',
    state       jsonb       NOT NULL,
    updated_at  timestamptz NOT NULL,
    PRIMARY KEY (trade_date, "index", variant)
);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'algo_state' AND column_name = 'symbol') THEN
        ALTER TABLE algo_state RENAME COLUMN symbol TO "index";
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'algo_state' AND column_name = 'variant') THEN
        ALTER TABLE algo_state ADD COLUMN variant text NOT NULL DEFAULT 'A';
        ALTER TABLE algo_state DROP CONSTRAINT IF EXISTS algo_state_pkey;
        ALTER TABLE algo_state ADD PRIMARY KEY (trade_date, "index", variant);
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS algo_state_day_variant ON algo_state (trade_date, variant);

-- The levels locked at 09:30: one row per index per day.
CREATE TABLE IF NOT EXISTS algo_levels (
    trade_date  date             NOT NULL,
    "index"     text             NOT NULL,
    expiry      text             NOT NULL,
    locked_at   timestamptz      NOT NULL,
    r1 double precision, r2 double precision, r3 double precision,
    s1 double precision, s2 double precision, s3 double precision,
    spot        double precision,           -- spot of the chain the levels came from
    PRIMARY KEY (trade_date, "index")
);

-- Every evaluated 5-minute candle with RSI and the filter values at its close.
CREATE TABLE IF NOT EXISTS algo_candles (
    trade_date        date             NOT NULL,
    "index"           text             NOT NULL,
    candle_start      timestamptz      NOT NULL,
    open double precision, high double precision, low double precision, close double precision,
    minutes           integer,                  -- 1-minute candles it was built from (5 = complete)
    rsi               double precision,
    toi_strength      double precision,         -- Trending OI strength %, signed as the app shows it
    toi_sentiment     text,                     -- Bullish | Bearish
    oi_change         text,                     -- BULLISH | BEARISH | NEUTRAL (OI & OI Change verdict)
    oi_change_points  double precision,
    components        text,                     -- Bullish | Bearish | Neutral | NULL (not ready)
    components_move   double precision,         -- index % points from components
    PRIMARY KEY (trade_date, "index", candle_start)
);

-- One row per day, index and variant (live + shadows), written at 15:35 IST and recomputable on demand.
-- P&L columns are for the live variant only (shadows: NULL; points for all).
CREATE TABLE IF NOT EXISTS algo_daily_summary (
    trade_date  date             NOT NULL,
    "index"     text             NOT NULL,
    variant     text             NOT NULL,
    is_live     boolean          NOT NULL,
    signals     integer          NOT NULL,     -- breakouts armed + range touches
    entries     integer          NOT NULL,
    wins        integer          NOT NULL,
    losses      integer          NOT NULL,
    points      double precision NOT NULL,     -- index points captured (PE: entry - exit)
    gross_pnl   double precision,
    charges     double precision,
    net_pnl     double precision,
    updated_at  timestamptz      NOT NULL,
    PRIMARY KEY (trade_date, "index", variant)
);
CREATE INDEX IF NOT EXISTS algo_daily_summary_day_variant ON algo_daily_summary (trade_date, variant);

-- Power Scalper (paper account 'Scalper'): one row per account per day, written at 15:35 IST (scalper_service.py).
-- trades = round trips (flat -> flat) of one instrument; net = realized - charges (same as the P&L calendar).
CREATE TABLE IF NOT EXISTS scalper_daily_summary (
    account_id   integer          NOT NULL REFERENCES pt_accounts(id),
    trade_date   date             NOT NULL,
    trades       integer          NOT NULL,
    wins         integer          NOT NULL,
    losses       integer          NOT NULL,
    fills        integer          NOT NULL,
    realized     double precision NOT NULL,
    charges      double precision NOT NULL,
    net          double precision NOT NULL,
    best_trade   double precision,             -- net of the best / worst round trip
    worst_trade  double precision,
    updated_at   timestamptz      NOT NULL,
    PRIMARY KEY (account_id, trade_date)
);

-- Option-chain snapshots: one row per strike per tracked minute (chain_snapshots.py, ATM +/- 25 strikes), so replays
-- can check the OI filters on past days.
CREATE TABLE IF NOT EXISTS oc_snapshots (
    trade_date   date             NOT NULL,
    ts           timestamptz      NOT NULL,     -- the tracker's minute (IST)
    "index"      text             NOT NULL,
    expiry       text             NOT NULL,
    strike       double precision NOT NULL,
    spot         double precision NOT NULL,
    ce_oi double precision, ce_prev_oi double precision, ce_ltp double precision, ce_prev_close double precision,
    ce_volume double precision, ce_iv double precision,
    pe_oi double precision, pe_prev_oi double precision, pe_ltp double precision, pe_prev_close double precision,
    pe_volume double precision, pe_iv double precision,
    PRIMARY KEY ("index", expiry, ts, strike)
);
CREATE INDEX IF NOT EXISTS oc_snapshots_day_index ON oc_snapshots (trade_date, "index");

-- Dashboard "Fix zones": the S1-S3 / R1-R3 set frozen on the chart, per index + expiry (dashboard_levels_api.py).
-- One active set per index + expiry; unfixing keeps the row (active = false), nothing is deleted.
CREATE TABLE IF NOT EXISTS dashboard_fixed_levels (
    id          bigserial        PRIMARY KEY,
    "index"     text             NOT NULL,
    expiry      text             NOT NULL,
    fixed_at    timestamptz      NOT NULL,
    r1 double precision, r2 double precision, r3 double precision,
    s1 double precision, s2 double precision, s3 double precision,
    active      boolean          NOT NULL DEFAULT true,
    unfixed_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_fixed_levels_one_active ON dashboard_fixed_levels ("index", expiry) WHERE active;

-- ================================================================ users and login (auth.py, ADR 0008)
-- Prefixed th_ because this database also holds another project's tables (it has its own "strategies" / "trades").
CREATE TABLE IF NOT EXISTS th_users (
    id             serial       PRIMARY KEY,
    username       text         NOT NULL UNIQUE,      -- lower case
    display_name   text         NOT NULL,
    password_hash  text,                              -- argon2id; NULL = can't log in until scripts/create_user.py sets one
    created_at     timestamptz  NOT NULL DEFAULT now(),
    active         boolean      NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS th_sessions (
    token_hash    text         PRIMARY KEY,           -- sha256 of the cookie's token (the token itself is never stored)
    user_id       integer      NOT NULL REFERENCES th_users(id),
    created_at    timestamptz  NOT NULL,
    last_seen_at  timestamptz  NOT NULL,
    expires_at    timestamptz  NOT NULL,              -- 30 days, extended when used
    ip            text         NOT NULL DEFAULT '',
    user_agent    text         NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS th_sessions_user ON th_sessions (user_id);

CREATE TABLE IF NOT EXISTS th_login_attempts (        -- kept one day; 5 failures / 15 min per username and per IP
    username  text         NOT NULL,
    ip        text         NOT NULL,
    at        timestamptz  NOT NULL,
    ok        boolean      NOT NULL
);
CREATE INDEX IF NOT EXISTS th_login_attempts_user ON th_login_attempts (username, at);
CREATE INDEX IF NOT EXISTS th_login_attempts_ip ON th_login_attempts (ip, at);

-- ================================================================ strategies (strategies.py, docs/users-and-strategies.md)
-- User -> strategy -> paper trades. A strategy's capital periods are pt_accounts rows (pt_accounts.strategy_id): the
-- open one has archived_at NULL; "Reset capital" archives it and opens a new one, so history is never lost.
CREATE TABLE IF NOT EXISTS th_strategies (
    id           serial           PRIMARY KEY,
    user_id      integer          NOT NULL REFERENCES th_users(id),
    name         text             NOT NULL,
    description  text             NOT NULL DEFAULT '',
    notes        text             NOT NULL DEFAULT '',     -- markdown
    capital      double precision NOT NULL,                -- the open period's starting capital
    kind         text             NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'algo')),
    created_at   timestamptz      NOT NULL DEFAULT now(),
    updated_at   timestamptz      NOT NULL DEFAULT now(),
    archived_at  timestamptz                              -- archived: read-only, history kept (no hard delete)
);
CREATE UNIQUE INDEX IF NOT EXISTS th_strategies_user_name ON th_strategies (user_id, lower(name));

CREATE TABLE IF NOT EXISTS th_user_prefs (               -- e.g. 'trading_into.paper' -> '7'
    user_id  integer  NOT NULL REFERENCES th_users(id),
    key      text     NOT NULL,
    value    text     NOT NULL,
    PRIMARY KEY (user_id, key)
);

-- Owner of every paper / algo row. Filled by scripts/migrate_users_strategies.py, which then makes them NOT NULL.
ALTER TABLE pt_accounts           ADD COLUMN IF NOT EXISTS strategy_id integer REFERENCES th_strategies(id);
ALTER TABLE pt_orders             ADD COLUMN IF NOT EXISTS strategy_id integer REFERENCES th_strategies(id);
ALTER TABLE pt_trades             ADD COLUMN IF NOT EXISTS strategy_id integer REFERENCES th_strategies(id);
ALTER TABLE pt_positions          ADD COLUMN IF NOT EXISTS strategy_id integer REFERENCES th_strategies(id);
ALTER TABLE pt_order_levels       ADD COLUMN IF NOT EXISTS strategy_id integer REFERENCES th_strategies(id);
ALTER TABLE scalper_daily_summary ADD COLUMN IF NOT EXISTS strategy_id integer REFERENCES th_strategies(id);
ALTER TABLE algo_daily_summary    ADD COLUMN IF NOT EXISTS strategy_id integer REFERENCES th_strategies(id);
ALTER TABLE algo_events           ADD COLUMN IF NOT EXISTS strategy_id integer REFERENCES th_strategies(id);
ALTER TABLE algo_state            ADD COLUMN IF NOT EXISTS strategy_id integer REFERENCES th_strategies(id);
CREATE INDEX IF NOT EXISTS pt_accounts_strategy ON pt_accounts (strategy_id);
CREATE INDEX IF NOT EXISTS pt_orders_strategy_day ON pt_orders (strategy_id, trade_date);
CREATE INDEX IF NOT EXISTS pt_trades_strategy_day ON pt_trades (strategy_id, trade_date);
CREATE INDEX IF NOT EXISTS pt_positions_strategy_day ON pt_positions (strategy_id, trade_date);

-- One row per strategy per day with fills (round trips flat -> flat; net = realized - charges, as the P&L calendar).
-- Replaces the Scalper-only scalper_daily_summary (its rows are copied here by the migration; that table is kept).
CREATE TABLE IF NOT EXISTS pt_daily_summary (
    strategy_id  integer          NOT NULL REFERENCES th_strategies(id),
    account_id   integer          NOT NULL REFERENCES pt_accounts(id),
    trade_date   date             NOT NULL,
    trades       integer          NOT NULL,
    wins         integer          NOT NULL,
    losses       integer          NOT NULL,
    fills        integer          NOT NULL,
    realized     double precision NOT NULL,
    charges      double precision NOT NULL,
    net          double precision NOT NULL,
    best_trade   double precision,
    worst_trade  double precision,
    updated_at   timestamptz      NOT NULL,
    PRIMARY KEY (account_id, trade_date)
);
CREATE INDEX IF NOT EXISTS pt_daily_summary_strategy ON pt_daily_summary (strategy_id, trade_date);

-- ================================================================ growth plans (growth_plans.py, docs/features/growth-plan.md)
CREATE TABLE IF NOT EXISTS th_growth_plans (
    id               serial           PRIMARY KEY,
    user_id          integer          NOT NULL REFERENCES th_users(id),
    name             text             NOT NULL,
    yearly_pct       double precision NOT NULL,
    method           text             NOT NULL CHECK (method IN ('compounded', 'simple')),
    initial_capital  double precision NOT NULL,
    start_month      date             NOT NULL,               -- the 1st of the plan's first month
    years            integer          NOT NULL CHECK (years BETWEEN 1 AND 20),
    created_at       timestamptz      NOT NULL DEFAULT now(),
    archived_at      timestamptz
);
CREATE INDEX IF NOT EXISTS th_growth_plans_user ON th_growth_plans (user_id);

-- A plan applied to a strategy. One active row per strategy (ended_at NULL); replaced ones stay as history.
CREATE TABLE IF NOT EXISTS th_strategy_plans (
    id               serial           PRIMARY KEY,
    strategy_id      integer          NOT NULL REFERENCES th_strategies(id),
    plan_id          integer          NOT NULL REFERENCES th_growth_plans(id),
    initial_capital  double precision NOT NULL,               -- the tracker's starting capital
    applied_at       timestamptz      NOT NULL,
    ended_at         timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS th_strategy_plans_active ON th_strategy_plans (strategy_id) WHERE ended_at IS NULL;

-- Capital changes of a strategy: cash flows for the Plan Tracker, never profit. amount = the change in equity.
CREATE TABLE IF NOT EXISTS th_capital_events (
    id             serial           PRIMARY KEY,
    strategy_id    integer          NOT NULL REFERENCES th_strategies(id),
    at             timestamptz      NOT NULL,
    kind           text             NOT NULL CHECK (kind IN ('start', 'set', 'reset')),
    amount         double precision NOT NULL,
    capital_after  double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS th_capital_events_strategy ON th_capital_events (strategy_id, at);

-- Strategy Builder drafts (builder.py): a named design per user; legs as JSON. Designs only, never orders.
CREATE TABLE IF NOT EXISTS th_builder_drafts (
    id          serial      PRIMARY KEY,
    user_id     integer     NOT NULL REFERENCES th_users(id),
    name        text        NOT NULL,
    symbol      text        NOT NULL CHECK (symbol IN ('NIFTY', 'BANKNIFTY')),
    multiplier  integer     NOT NULL DEFAULT 1,
    legs        jsonb       NOT NULL,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS th_builder_drafts_user ON th_builder_drafts (user_id);
