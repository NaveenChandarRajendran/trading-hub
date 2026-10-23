from datetime import datetime

from keep_awake import ES_CONTINUOUS, ES_SYSTEM_REQUIRED, KeepAwake
from sig_indicators import IST


class Kernel:
    def __init__(self):
        self.calls = []

    def SetThreadExecutionState(self, flags):
        self.calls.append(flags)


def at(hm):
    return datetime.fromisoformat(f"2026-10-26T{hm}:00").replace(tzinfo=IST)


def test_pc_kept_awake_until_four_then_released():
    now, k = [at("08:50")], Kernel()
    ka = KeepAwake(kernel=k, clock=lambda: now[0])
    ka.tick()
    assert k.calls == [ES_CONTINUOUS | ES_SYSTEM_REQUIRED] and ka.on
    now[0] = at("15:59")
    ka.tick()
    now[0] = at("16:00")
    ka.tick()
    assert k.calls[-1] == ES_CONTINUOUS and not ka.on
    ka.tick()
    assert len(k.calls) == 3  # nothing more to do after release


def test_started_after_four_does_nothing():
    k = Kernel()
    KeepAwake(kernel=k, clock=lambda: at("17:00")).tick()
    assert k.calls == []
