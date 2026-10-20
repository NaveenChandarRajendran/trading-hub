"""
capture_feed.py - records raw Dhan feed frames (base64) into fixtures/dhan_feed_capture.json for test_dhan_feed.py.
Read-only market data. Run during market hours (Windows Command Prompt, in this folder):
    set DHAN_CLIENT_ID=...
    set DHAN_ACCESS_TOKEN=...
    python capture_feed.py NSE_FNO:52175 NSE_FNO:52176 IDX_I:13 --frames 20
Security IDs for option strikes come from the option chain (or data/security_ids.json for stocks).
Check the file before committing it: it holds market data only, never the token.
"""
import argparse
import asyncio
import base64
import json
import os
from datetime import datetime
from pathlib import Path

from dhan_feed import FEED_URL, FULL, parse_packets, subscription_messages

OUT = Path(__file__).with_name("fixtures") / "dhan_feed_capture.json"


async def capture(instruments, frames):
    import websockets
    url = FEED_URL.format(token=os.environ["DHAN_ACCESS_TOKEN"], client_id=os.environ["DHAN_CLIENT_ID"])
    got = []
    async with websockets.connect(url, max_size=None, ping_interval=None) as ws:
        for m in subscription_messages(instruments, FULL):
            await ws.send(m)
        while len(got) < frames:
            frame = await asyncio.wait_for(ws.recv(), 30)
            if isinstance(frame, bytes):
                got.append(frame)
                print(", ".join(p["kind"] for p in parse_packets(frame)))
    return got


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("instruments", nargs="+", help="SEGMENT:SECURITY_ID, e.g. NSE_FNO:52175")
    ap.add_argument("--frames", type=int, default=20)
    a = ap.parse_args()
    instruments = [(s.split(":")[0], int(s.split(":")[1])) for s in a.instruments]
    frames = asyncio.run(capture(instruments, a.frames))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"capturedAt": datetime.now().isoformat(timespec="seconds"),
                               "instruments": a.instruments,
                               "frames": [base64.b64encode(f).decode() for f in frames]}, indent=1))
    print(f"wrote {len(frames)} frames to {OUT}")


if __name__ == "__main__":
    main()
