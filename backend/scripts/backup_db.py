"""
scripts/backup_db.py - full plain-SQL dump of the Trading Hub database with pg_dump:
    backend/backups/trading-hub-YYYY-MM-DD.sql      (IST date; a second run the same day overwrites that day's file)
Nothing is ever deleted: old backups stay until you remove them yourself.

    cd backend
    python scripts/backup_db.py
DATABASE_URL comes from backend/.env.local. pg_dump is found on PATH or in C:\\Program Files\\PostgreSQL\\<version>\\bin.
The password is passed to pg_dump through PGPASSWORD (never on the command line, so it is not visible in the process list).
Restore:  psql -d <database> -f backend/backups/trading-hub-YYYY-MM-DD.sql
"""
import glob
import os
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)

from envfile import load_env_file  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))


def find_pg_dump():
    exe = shutil.which("pg_dump")
    if exe:
        return exe
    found = sorted(glob.glob(r"C:\Program Files\PostgreSQL\*\bin\pg_dump.exe"),
                   key=lambda p: int(p.split(os.sep)[-3]) if p.split(os.sep)[-3].isdigit() else 0)
    if not found:
        raise SystemExit("pg_dump not found: add PostgreSQL's bin folder to PATH")
    return found[-1]


def backup(dsn, out_dir, today=None, pg_dump=None):
    """Runs pg_dump into out_dir/trading-hub-<IST date>.sql and returns the file path."""
    u = urlparse(dsn)
    day = (today or datetime.now(IST).date()).isoformat()
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"trading-hub-{day}.sql")
    env = {**os.environ, "PGPASSWORD": unquote(u.password or "")}
    cmd = [pg_dump or find_pg_dump(), "--host", u.hostname or "localhost", "--port", str(u.port or 5432),
           "--username", unquote(u.username or ""), "--dbname", u.path.lstrip("/"), "--format", "plain",
           "--no-owner", "--encoding", "UTF8", "--file", path]
    r = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"pg_dump failed ({r.returncode}): {r.stderr.strip()}")
    return path


def main():
    load_env_file(os.path.join(BACKEND, ".env.local"))
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is not set: add it to backend/.env.local")
    path = backup(dsn, os.path.join(BACKEND, "backups"))
    print(f"Backup written: {path} ({os.path.getsize(path) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
