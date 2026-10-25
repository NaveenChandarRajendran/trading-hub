# ADR 0005: Auto paper positions are per rule, not per account

Date: 25-Oct-2026. Status: accepted (owner asked for Dharani v2 to run alongside v1 on MegaBull).

## Context
The auto trader allowed one open position per account per index. Dharani v2 trades on the MegaBull account next to
the existing MegaBull rule (4 Pillar / Dharani v1), so per-account positions would let whichever fired first block the
other, and the 15 Nov comparison would be skewed.

## Decision
Each rule is a "slot" (`autopaper.RULE_ACCOUNT`: tradingHub → Trading Hub, megabull and dharaniV2 → MegaBull). One open
position per slot per index. Daily limits stay per account. A rule never buys the option another rule already holds on
the same account (MegaBull nets positions by instrument, so one stop or exit could close both); that entry is skipped
with an alert. Trades saved before this change use their account as the slot.

## Consequences
Two MegaBull trades can be open on one index at once (different options). Exits, stops and square-off still act per
trade. Test: `test_autopaper.py::test_dharani_v2_has_its_own_slot_but_never_buys_the_option_v1_holds`.
