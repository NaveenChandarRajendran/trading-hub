"""
scripts/create_user.py - Trading Hub users (there is no sign-up page). Run in backend/:

    python scripts/create_user.py --username naveen --name "Naveen"     create (asks for the password twice)
    python scripts/create_user.py --username naveen --reset-password     new password; logs out every browser
    python scripts/create_user.py --username naveen --deactivate         can't log in any more; open sessions end
    python scripts/create_user.py --username naveen --activate
    python scripts/create_user.py --list

DATABASE_URL comes from backend/.env.local. Passwords are typed at the prompt (never on the command line, so they
don't land in the shell history) and stored as argon2id hashes. At least 8 characters.
"""
import argparse
import getpass
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)

from auth import Auth, AuthPgStore  # noqa: E402
from envfile import load_env_file  # noqa: E402


def ask_password():
    pw = getpass.getpass("Password (8+ characters): ")
    if len(pw) < 8:
        raise SystemExit("Password must be at least 8 characters.")
    if getpass.getpass("Same password again: ") != pw:
        raise SystemExit("The passwords don't match. Nothing changed.")
    return pw


def main(argv=None, password_prompt=ask_password, dsn=None):
    ap = argparse.ArgumentParser(description="Create or change Trading Hub users.")
    ap.add_argument("--username")
    ap.add_argument("--name", help="display name shown in the top bar (create only)")
    act = ap.add_mutually_exclusive_group()
    act.add_argument("--reset-password", action="store_true")
    act.add_argument("--deactivate", action="store_true")
    act.add_argument("--activate", action="store_true")
    act.add_argument("--list", action="store_true")
    a = ap.parse_args(argv)
    if not a.list and not a.username:
        ap.error("--username is required")

    if dsn is None:
        load_env_file(os.path.join(BACKEND, ".env.local"))
        dsn = os.getenv("DATABASE_URL", "").strip()
        if not dsn:
            raise SystemExit("DATABASE_URL is not set (backend/.env.local).")
    from store import PgStore
    pg = PgStore(dsn)
    try:
        auth = Auth(AuthPgStore(pg))
        try:
            if a.list:
                with pg._cursor() as cur:
                    cur.execute("SELECT username, display_name, active, password_hash IS NOT NULL, created_at "
                                "FROM th_users ORDER BY id")
                    for u, n, active, has_pw, at in cur.fetchall():
                        print(f"{u:<16} {n:<20} {'active' if active else 'inactive':<9} "
                              f"{'password set' if has_pw else 'NO PASSWORD':<13} since {at:%Y-%m-%d}")
            elif a.reset_password:
                auth.set_password(a.username, password_prompt())
                print(f"Password changed for {auth.norm(a.username)}; their browsers are logged out.")
            elif a.deactivate or a.activate:
                auth.set_active(a.username, a.activate)
                print(f"{auth.norm(a.username)} is now {'active' if a.activate else 'inactive'}.")
            else:
                row = auth.store.user_by_name(auth.norm(a.username))
                if row and row[1] is None:  # made by the data migration without a password: set it now
                    auth.set_password(a.username, password_prompt())
                    print(f"Password set for {row[0].username}. Open http://127.0.0.1:8000 and log in.")
                    return
                if row:
                    raise ValueError(f"user {auth.norm(a.username)!r} already exists (use --reset-password)")
                user = auth.create_user(a.username, a.name or a.username, password_prompt())
                print(f"Created {user.username} ({user.display_name}). Open http://127.0.0.1:8000 and log in.")
        except ValueError as e:
            raise SystemExit(str(e))
    finally:
        pg.close()


if __name__ == "__main__":
    main()
