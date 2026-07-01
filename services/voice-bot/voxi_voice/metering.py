"""
Voice-minute metering with a hard cutoff (PLAN §6.4 / eng-F6, TEST-PLAN conv-05).

The BFF owns the entitlement ledger (services/voxi-api/src/metering.ts). The bot is the ENFORCEMENT point
for the live session: it tracks elapsed seconds against a per-session minute cap, emits soft warnings at
80% and 90% (in-persona, so the user can wrap up), gives a short grace to finish the current turn, then
HARD-DISCONNECTS at the cap with a graceful in-persona message. The cap never silently runs over —
overage is real money.

This module is pure/clock-injected so the test asserts the cutoff deterministically without sleeping.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Callable


class MeterEvent(Enum):
    OK = "ok"
    SOFT_80 = "soft_warning_80"
    SOFT_90 = "soft_warning_90"
    HARD_CUTOFF = "hard_cutoff"


# In-persona copy for the metering states (PLAN §6.4 "graceful in-persona message"). Short declaratives, dry.
CUTOFF_MESSAGE = "That is our minute, I'm afraid. The meter has the final word. Until next time."
SOFT_80_MESSAGE = "We are nearing the end of our allotted minutes. Make the next thought count."
SOFT_90_MESSAGE = "One more thought, perhaps. We are almost out of time."


@dataclass
class MeterDecision:
    event: MeterEvent
    elapsed_seconds: float
    remaining_seconds: float
    message: str | None = None
    should_disconnect: bool = False


class VoiceMeter:
    """
    Tracks one session's elapsed voice time against `cap_seconds`.

    `tick(now)` is called on each pipeline event (turn boundary, audio frame). It is monotonic-safe and
    idempotent on the warning transitions: each soft warning fires at most once. Once the cap is hit it
    latches HARD_CUTOFF — every subsequent tick keeps returning a disconnect decision (fail-closed, so a
    racing in-flight turn can't sneak past).

    A short `grace_seconds` lets the CURRENT turn finish: the cutoff message is delivered, but the actual
    transport disconnect is signalled so the pipeline can play the final audio then drop. The cap itself is
    not extended — grace is for the audio already in flight, not new speech.
    """

    def __init__(
        self,
        cap_seconds: float,
        *,
        now: Callable[[], float],
        grace_seconds: float = 3.0,
    ) -> None:
        if cap_seconds <= 0:
            raise ValueError("cap_seconds must be positive")
        self.cap_seconds = cap_seconds
        self.grace_seconds = grace_seconds
        self._now = now
        self._start: float | None = None
        self._fired_80 = False
        self._fired_90 = False
        self._latched_cutoff = False

    def start(self) -> None:
        self._start = self._now()

    def elapsed(self) -> float:
        if self._start is None:
            return 0.0
        return max(0.0, self._now() - self._start)

    def tick(self) -> MeterDecision:
        elapsed = self.elapsed()
        remaining = max(0.0, self.cap_seconds - elapsed)

        if self._latched_cutoff or elapsed >= self.cap_seconds:
            self._latched_cutoff = True
            return MeterDecision(
                event=MeterEvent.HARD_CUTOFF,
                elapsed_seconds=elapsed,
                remaining_seconds=0.0,
                message=CUTOFF_MESSAGE,
                should_disconnect=True,
            )

        frac = elapsed / self.cap_seconds
        if frac >= 0.90 and not self._fired_90:
            self._fired_90 = True
            return MeterDecision(MeterEvent.SOFT_90, elapsed, remaining, SOFT_90_MESSAGE)
        if frac >= 0.80 and not self._fired_80:
            self._fired_80 = True
            return MeterDecision(MeterEvent.SOFT_80, elapsed, remaining, SOFT_80_MESSAGE)

        return MeterDecision(MeterEvent.OK, elapsed, remaining)

    @property
    def cut_off(self) -> bool:
        return self._latched_cutoff
