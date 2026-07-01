"""
Shared session-builder for the tests. Assembles a VoicePipeline from fakes with a controllable clock, so
every test drives the SAME wiring a real connection would, minus the credentialed transport.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from voxi_voice import (
    CANONICAL_VOXI_VOICE_ID,
    FakeBff,
    FakeLLM,
    FakeSTT,
    FakeTTS,
    PersonaInjector,
    ScopedToken,
    ToolBridge,
    TranscriptWriter,
    VoiceMeter,
    VoicePipeline,
)


class Clock:
    """A manual clock: advance() moves time; now() reads it. Lets the meter test assert the cutoff exactly."""

    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def now(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


@dataclass
class Harness:
    pipeline: VoicePipeline
    persona: PersonaInjector
    bff: FakeBff
    llm: FakeLLM
    tts: FakeTTS
    meter: VoiceMeter
    transcript: TranscriptWriter
    token: ScopedToken
    clock: Clock


def build_harness(
    *,
    user_id: str = "user_alice",
    session_id: str = "sess_123",
    scripted_stt: list[str] | None = None,
    cap_seconds: float = 300.0,
    voice_id: str = CANONICAL_VOXI_VOICE_ID,
    clock: Clock | None = None,
    persona: PersonaInjector | None = None,
    bff: FakeBff | None = None,
    start_turn_index: int = 0,
) -> Harness:
    clock = clock or Clock()
    persona = persona or PersonaInjector()
    bff = bff if bff is not None else FakeBff()
    token = ScopedToken(value="scoped_tok_abc", user_id=user_id, session_id=session_id)

    stt = FakeSTT(scripted=list(scripted_stt or ["a camera", "and the lens"]))
    llm = FakeLLM()
    tts = FakeTTS(voice_id=voice_id)
    meter = VoiceMeter(cap_seconds, now=clock.now, grace_seconds=3.0)
    transcript = TranscriptWriter(bff, token)
    tools = ToolBridge(bff, token)

    pipeline = VoicePipeline(
        stt=stt,
        llm=llm,
        tts=tts,
        persona_injector=persona,
        meter=meter,
        transcript=transcript,
        tools=tools,
        start_turn_index=start_turn_index,
    )
    return Harness(pipeline, persona, bff, llm, tts, meter, transcript, token, clock)
