"""
scripts/migrate_users_strategies.py - moves the existing paper / algo data under user "naveen" and his strategies
(docs/users-and-strategies.md). Run in backend/ with the backend STOPPED:

    python scripts/migrate_users_strategies.py              backup (pg_dump), migrate, print counts before / after
    python scripts/migrate_users_strategies.py --dry-run    same checks and counts, then roll back (still backs up)

1. pg_dump backup to backend/backups/ (scripts/backup_db.py); stops if that fails.
2. Row counts of every table involved, and each account's P&L (realized, charges, fills) before.
3. In ONE transaction:
   - user "naveen" (display name "Naveen", no password: set it with scripts/create_user.py --username naveen);
   - one strategy per existing account name, owned by naveen, capital = its open account's:
         NULL (Paper Trading) -> "Manual (legacy)"     'Algo' -> "OI Breakout Algo" (kind algo)     'Scalper' -> "Scalper"
     (an old "Reset account" period with the same name joins the same strategy, so its history stays with it);
     "OI Breakout Algo" is always made, with an 'Algo' account if there was none, because the algo always runs;
   - strategy_id filled in where it is empty: pt_accounts, then pt_orders / pt_trades / pt_positions /
     pt_order_levels / scalper_daily_summary through their account, algo_events / algo_state / algo_daily_summary
     -> "OI Breakout Algo"; scalper_daily_summary rows copied to pt_daily_summary;
   - every strategy_id column made NOT NULL (refused if any row is still empty);
   - per-strategy P&L after must equal the sum of its accounts' P&L before, else everything is rolled back.
4. Counts after. Running it again changes nothing (every step only fills what is missing).
Another account name than the three above stops the migration before anything changes.
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)
sys.path.insert(0, HERE)

from envfile import load_env_file  # noqa: E402

OWNER = ("naveen", "Naveen")
ALGO = "OI Breakout Algo"
MAPPING = [(None, "Manual (legacy)", "manual"), ("Algo", ALGO, "algo"), ("Scalper", "Scalper", "manual")]
DEFAULT_CAPITAL = 100_000
ACCOUNT_TABLES = ("pt_orders", "pt_trades", "pt_positions", "pt_order_levels", "scalper_daily_summary")
ALGO_TABLES = ("algo_events", "algo_state", "algo_daily_summary")
NOT_NULL = ("pt_accounts", *ACCOUNT_TABLES, *ALGO_TABLES, "pt_daily_summary")
COUNTED = ("th_users", "th_strategies", "pt_accounts", *ACCOUNT_TABLES, "pt_daily_summary", *ALGO_TABLES)


def counts(cur):
    out = {}
    for t in COUNTED:
        cur.execute(f"SELECT count(*) FROM {t}")
        out[t] = cur.fetchone()[0]
    return out


def pnl_by(cur, key):
    """{key: (realized, charges, fills)}; key 'account_id' or 'strategy_id'."""
    cur.execute(f"SELECT {key}, round(sum(realized)::numeric, 2) FROM pt_positions GROUP BY {key}")
    realized = dict(cur.fetchall())
    cur.execute(f"SELECT {key}, round(sum(brokerage + stt + transaction + sebi + stamp + gst)::numeric, 2), count(*) "
                f"FROM pt_trades GROUP BY {key}")
    charges = {k: (c, n) for k, c, n in cur.fetchall()}
    keys = set(realized) | set(charges)
    return {k: (float(realized.get(k) or 0), float(charges.get(k, (0, 0))[0] or 0), charges.get(k, (0, 0))[1])
            for k in keys}


def migrate(cur, log=print):
    """Everything inside the caller's transaction. Returns a summary dict."""
    cur.execute("SELECT DISTINCT name FROM pt_accounts")
    unknown = [n for (n,) in cur.fetchall() if n not in {m[0] for m in MAPPING}]
    if unknown:
        raise SystemExit(f"Unknown account names {unknown}: nothing changed. Map them in MAPPING first.")

    accounts_before = pnl_by(cur, "account_id")
    cur.execute("INSERT INTO th_users (username, display_name) VALUES (%s, %s) ON CONFLICT (username) DO NOTHING",
                OWNER)
    cur.execute("SELECT id FROM th_users WHERE username=%s", (OWNER[0],))
    uid = cur.fetchone()[0]

    made, filled = [], {}
    for acc_name, st_name, kind in MAPPING:
        cur.execute("SELECT id, capital, created_at, archived_at FROM pt_accounts WHERE name IS NOT DISTINCT FROM %s "
                    "ORDER BY id", (acc_name,))
        accs = cur.fetchall()
        if not accs and kind != "algo":
            continue
        cur.execute("SELECT id FROM th_strategies WHERE user_id=%s AND lower(name)=lower(%s)", (uid, st_name))
        row = cur.fetchone()
        if row:
            sid = row[0]
        else:
            open_accs = [a for a in accs if a[3] is None]
            capital = (open_accs or accs)[-1][1] if accs else DEFAULT_CAPITAL
            cur.execute("INSERT INTO th_strategies (user_id, name, capital, kind, created_at, updated_at) "
                        "VALUES (%s, %s, %s, %s, COALESCE(%s, now()), now()) RETURNING id",
                        (uid, st_name, capital, kind, accs[0][2] if accs else None))
            sid = cur.fetchone()[0]
            made.append(st_name)
        if not accs:  # the algo always runs: give it its account now
            cur.execute("INSERT INTO pt_accounts (capital, created_at, name, strategy_id) VALUES (%s, now(), %s, %s)",
                        (DEFAULT_CAPITAL, acc_name, sid))
        cur.execute("UPDATE pt_accounts SET strategy_id=%s WHERE name IS NOT DISTINCT FROM %s AND strategy_id IS NULL",
                    (sid, acc_name))
        filled["pt_accounts"] = filled.get("pt_accounts", 0) + cur.rowcount

    for t in ACCOUNT_TABLES:
        cur.execute(f"UPDATE {t} x SET strategy_id = a.strategy_id FROM pt_accounts a "
                    f"WHERE x.account_id = a.id AND x.strategy_id IS NULL")
        filled[t] = cur.rowcount
    cur.execute("SELECT id FROM th_strategies WHERE user_id=%s AND kind='algo' AND lower(name)=lower(%s)", (uid, ALGO))
    algo_sid = cur.fetchone()[0]
    for t in ALGO_TABLES:
        cur.execute(f"UPDATE {t} SET strategy_id=%s WHERE strategy_id IS NULL", (algo_sid,))
        filled[t] = cur.rowcount
    cur.execute("INSERT INTO pt_daily_summary (strategy_id, account_id, trade_date, trades, wins, losses, fills, "
                "realized, charges, net, best_trade, worst_trade, updated_at) "
                "SELECT strategy_id, account_id, trade_date, trades, wins, losses, fills, realized, charges, net, "
                "best_trade, worst_trade, updated_at FROM scalper_daily_summary ON CONFLICT DO NOTHING")
    filled["pt_daily_summary (copied)"] = cur.rowcount

    for t in NOT_NULL:
        cur.execute(f"SELECT count(*) FROM {t} WHERE strategy_id IS NULL")
        empty = cur.fetchone()[0]
        if empty:
            raise SystemExit(f"{t}: {empty} rows still without strategy_id. Rolled back, nothing changed.")
        cur.execute(f"ALTER TABLE {t} ALTER COLUMN strategy_id SET NOT NULL")

    # P&L check: each strategy's totals = the sum of its accounts' totals before the migration
    cur.execute("SELECT id, strategy_id FROM pt_accounts")
    owner = dict(cur.fetchall())
    expected = {}
    for acc, (r, c, n) in accounts_before.items():
        e = expected.setdefault(owner[acc], [0.0, 0.0, 0])
        e[0], e[1], e[2] = round(e[0] + r, 2), round(e[1] + c, 2), e[2] + n
    after = {k: [round(v[0], 2), round(v[1], 2), v[2]] for k, v in pnl_by(cur, "strategy_id").items()}
    if after != expected:
        raise SystemExit(f"P&L check failed (expected {expected}, got {after}). Rolled back, nothing changed.")
    cur.execute("SELECT s.id, s.name, s.kind, s.capital FROM th_strategies s WHERE s.user_id=%s ORDER BY s.id", (uid,))
    strategies = [(i, n, k, c, after.get(i, [0.0, 0.0, 0])) for i, n, k, c in cur.fetchall()]
    return {"user_id": uid, "made": made, "filled": filled, "strategies": strategies}


def print_counts(before, after, log=print):
    log(f"{'table':<24}{'before':>9}{'after':>9}")
    for t in COUNTED:
        mark = "" if before[t] == after[t] else f"   (+{after[t] - before[t]})"
        log(f"{t:<24}{before[t]:>9}{after[t]:>9}{mark}")


def main(argv=None, dsn=None, backup=None, log=print):
    ap = argparse.ArgumentParser(description="Move existing paper / algo data under user naveen and his strategies.")
    ap.add_argument("--dry-run", action="store_true", help="check and print, then roll back")
    a = ap.parse_args(argv)
    if dsn is None:
        load_env_file(os.path.join(BACKEND, ".env.local"))
        dsn = os.getenv("DATABASE_URL", "").strip()
        if not dsn:
            raise SystemExit("DATABASE_URL is not set (backend/.env.local).")
    if backup is None:
        import backup_db
        backup = lambda: backup_db.backup(dsn, os.path.join(BACKEND, "backups"))  # noqa: E731
    path = backup()
    log(f"Backup written: {path}")

    from store import PgStore
    pg = PgStore(dsn)  # creates any missing th_ tables / strategy_id columns (schema.sql, additive)
    try:
        conn = pg._pool.getconn()
        try:
            with conn.cursor() as cur:
                before = counts(cur)
                result = migrate(cur, log)
                after = counts(cur)
            print_counts(before, after, log)
            log(f"strategy_id filled: {result['filled']}")
            log(f"strategies made: {result['made'] or 'none (already migrated)'}")
            for i, n, k, c, (r, ch, f) in result["strategies"]:
                log(f"  #{i} {n} ({k}) capital {c:,.0f}: realized {r:,.2f}, charges {ch:,.2f}, fills {f}")
            if a.dry_run:
                conn.rollback()
                log("Dry run: rolled back, nothing changed.")
            else:
                conn.commit()
                log("Migrated. Set the password: python scripts/create_user.py --username naveen")
            return before, after, result
        except BaseException:
            conn.rollback()
            raise
        finally:
            pg._pool.putconn(conn)
    finally:
        pg.close()


if __name__ == "__main__":
    main()
