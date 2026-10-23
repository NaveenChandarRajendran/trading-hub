"""
capture_chain.py - saves one real Dhan option chain as test fixtures. Read-only market data, one Dhan call per symbol.
Works after market hours too (Dhan then returns the last session's chain). In this folder:
    python capture_chain.py NIFTY BANKNIFTY
Credentials come from DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN, or from backend/.env.local (KEY=VALUE lines, never committed).
Writes, per symbol (nearest expiry unless --expiry is given):
    fixtures/dhan_chain_<SYMBOL>_<expiry>.json                      raw /optionchain response (backend tests)
    ../frontend/src/shared/dhan/__fixtures__/<symbol>-<date>.json   GET /api/option-chain body (frontend tests)
Check the files before committing them: they hold market data only, never the token.
"""
import argparse
import json
import os
from datetime import datetime
from pathlib import Path

from chain_cache import FALLBACK_LOT_SIZE, Entry, chain_response
from dhan_client import DhanClient, parse_chain
from instruments import OptionInstruments
from store import IST

HERE = Path(__file__).parent
RAW_DIR = HERE / "fixtures"
API_DIR = HERE.parent / "frontend" / "src" / "shared" / "dhan" / "__fixtures__"


def load_env_file(path=HERE / ".env.local"):
    """Sets missing env vars from KEY=VALUE lines. Values are never printed."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("symbols", nargs="*", default=["NIFTY"])
    ap.add_argument("--expiry", default="", help="YYYY-MM-DD (default: nearest)")
    a = ap.parse_args()

    load_env_file()
    client = DhanClient()
    inst = OptionInstruments(str(HERE / "data" / "option_instruments.json"))
    RAW_DIR.mkdir(exist_ok=True)
    API_DIR.mkdir(parents=True, exist_ok=True)
    for sym in (s.upper() for s in a.symbols):
        expiry = a.expiry or client.expiries(sym)[0]
        raw = client.option_chain_raw(sym, expiry)
        now = datetime.now(IST).replace(microsecond=0)
        (RAW_DIR / f"dhan_chain_{sym}_{expiry}.json").write_text(json.dumps(raw, indent=1), encoding="utf-8")

        try:
            rows = inst.chain(sym, expiry)
            lot = next((r[k]["lotSize"] for r in rows for k in ("ce", "pe") if r[k]), None) or FALLBACK_LOT_SIZE[sym]
        except Exception:
            lot = FALLBACK_LOT_SIZE[sym]
        body = chain_response(sym, expiry, Entry(parse_chain(raw), now), False, lot, now, False, False)
        out = API_DIR / f"{sym.lower()}-{now:%Y-%m-%d}.json"
        out.write_text(json.dumps(body, indent=1), encoding="utf-8")
        print(f"{sym} {expiry}: spot {body['meta']['spot']}, {len(body['rows'])} strikes, lot {lot} -> {out.name}")


if __name__ == "__main__":
    main()
