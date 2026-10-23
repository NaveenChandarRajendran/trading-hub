"""
keep_awake.py - stops Windows from SLEEPING while the backend runs on a trading day, until 16:00 IST (owner,
24-Oct-2026: the PC must not sleep between the morning start and the close). Uses SetThreadExecutionState, the same
call video-call apps use: the screen may still turn off or lock (that is fine, the app keeps running), but the PC does
not go to sleep. After 16:00, or when the backend is closed, Windows' normal sleep settings apply again.
Closing a laptop lid can still sleep the PC, depending on the lid setting in Windows' power options.
No effect on other systems.
"""
import logging
import sys
import threading
from datetime import datetime

from sig_indicators import IST

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
UNTIL = (16, 0)
log = logging.getLogger("keep_awake")


def wanted(now):
    return (now.hour, now.minute) < UNTIL


class KeepAwake:
    def __init__(self, kernel=None, clock=lambda: datetime.now(IST), every=60):
        if kernel is None and sys.platform == "win32":
            import ctypes
            kernel = ctypes.windll.kernel32
        self.kernel, self.clock, self.every = kernel, clock, every
        self.on = False
        self._stop = threading.Event()

    def tick(self):
        """Sets or clears the flag for the current time. Called from the thread that set it (Windows keeps the flag
        per thread)."""
        if self.kernel is None:
            return
        want = wanted(self.clock())
        if want:
            self.kernel.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        elif self.on:
            self.kernel.SetThreadExecutionState(ES_CONTINUOUS)
        if want != self.on:
            log.info("Keep awake %s", "ON until 16:00 IST: the PC will not sleep" if want else "OFF: normal sleep settings again")
        self.on = want

    def _run(self):
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("keep awake failed")
            self._stop.wait(self.every)
        if self.kernel is not None and self.on:
            self.kernel.SetThreadExecutionState(ES_CONTINUOUS)

    def start(self):
        if self.kernel is None:
            return None
        t = threading.Thread(target=self._run, name="keep-awake", daemon=True)
        t.start()
        return t

    def stop(self):
        self._stop.set()
