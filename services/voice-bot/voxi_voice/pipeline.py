"""
The Voxi realtime voice pipeline (PLAN §6.3).

A vendor-agnostic orchestration of the cascade: STT -> LLM -> TTS (canonical Voxi voice), with:
  - persona injected ONCE at session start (PersonaInjector),
  - SmartTurnDetection-driven barge-in that DISCARDS the partial assistant turn,
  - voice_id consistency enforcement (every played chunk must carry the session's canonical voice_id),
  - voice-minute hard cutoff (VoiceMeter),
  - a tool bridge + idempotent transcript write-back through the BFF (single writer).

This module is the transport-agnostic core. `transport.py` adapts it to Pipecat's SmallWebRTC frame graph
when Pipecat is installed; here, audio in/out are plain async iterables / sinks, so the whole loop runs and
is fully tested with no creds and no Pipecat.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable

from .bff_bridge import ToolBridge, TranscriptWriter
from .metering import MeterEvent, VoiceMeter
from .persona import PersonaInjector
from .providers import LLMProvider, STTProvider, Transcription, TtsChunk, TtsProvider, Turn


class VoiceConsistencyError(RuntimeError):
    """Raised if a TTS chunk's voice_id is not the session's canonical Voxi voice_id (§6.1 / conv-03)."""


@dataclass
class SessionResult:
    """Observable outcome of a run, asserted by the tests."""

    turns: list[Turn] = field(default_factory=list)
    audio_voice_ids: list[str] = field(default_factory=list)
    interrupted_turns: int = 0
    persona_injections: int = 0
    disconnected_by_meter: bool = False
    meter_events: list[MeterEvent] = field(default_factory=list)


# A SmartTurnDetection signal. In production this is Pipecat's LLM-based end-of-turn classifier; here it's a
# pluggable predicate so a test can script a barge-in deterministically. Returns True when the user has
# started a NEW turn while Voxi is still speaking (i.e. a genuine interruption, not a mid-thought pause).
BargeInDetector = Callable[[], bool]


class VoicePipeline:
    """
    One live session. Build it per connection; on reconnect, build a fresh pipeline against the SAME
    PersonaInjector + TranscriptWriter for the session so persona stays injected-once and write-back stays
    idempotent.
    """

    def __init__(
        self,
        *,
        stt: STTProvider,
        llm: LLMProvider,
        tts: TtsProvider,
        persona_injector: PersonaInjector,
        meter: VoiceMeter,
        transcript: TranscriptWriter,
        tools: ToolBridge | None = None,
        audio_sink: Callable[[TtsChunk], Awaitable[None]] | None = None,
        start_turn_index: int = 0,
    ) -> None:
        self._stt = stt
        self._llm = llm
        self._tts = tts
        self._persona = persona_injector
        self._meter = meter
        self._transcript = transcript
        self._tools = tools
        self._audio_sink = audio_sink
        self._turn_index = start_turn_index
        # The canonical voice_id the persona was minted with — every chunk must match it.
        self._canonical_voice_id = persona_injector.persona.voice_id
        self._history: list[Turn] = []
        self._result = SessionResult()

    @property
    def result(self) -> SessionResult:
        return self._result

    async def run(
        self,
        utterances: list[tuple[AsyncIterator[bytes], BargeInDetector | None]],
    ) -> SessionResult:
        """
        Drive a session over a list of user utterances. Each utterance is (audio_frames, barge_in_detector).
        `barge_in_detector` (optional) fires DURING Voxi's reply to that utterance to simulate the user
        interrupting; the in-flight assistant turn is then discarded.
        """
        # Persona injected exactly once, at session start (no-op on a reconnect).
        persona = self._persona.inject()
        self._result.persona_injections = self._persona.injected_count

        self._meter.start()
        for audio_frames, barge in utterances:
            # Meter check at the turn boundary — fail-closed before we spend any vendor budget.
            decision = self._meter.tick()
            self._result.meter_events.append(decision.event)
            if decision.should_disconnect:
                await self._deliver_cutoff(decision.message or "")
                self._result.disconnected_by_meter = True
                break

            user_text = await self._collect_final(audio_frames)
            user_turn = Turn(role="user", text=user_text)
            self._history.append(user_turn)
            await self._commit_turn(user_turn)

            assistant_turn = await self._respond(persona.instructions, user_text, barge)
            self._history.append(assistant_turn)
            await self._commit_turn(assistant_turn)
            if assistant_turn.interrupted:
                self._result.interrupted_turns += 1

            # Post-turn meter check (a long turn may have crossed the cap).
            post = self._meter.tick()
            self._result.meter_events.append(post.event)
            if post.should_disconnect:
                await self._deliver_cutoff(post.message or "")
                self._result.disconnected_by_meter = True
                break

        self._result.turns = list(self._history)
        return self._result

    # ---- internals ----
    async def _collect_final(self, audio_frames: AsyncIterator[bytes]) -> str:
        final = ""
        async for t in self._stt.transcribe(audio_frames):
            if t.is_final:
                final = t.text
        return final

    async def _respond(self, persona_instructions: str, user_text: str, barge: BargeInDetector | None) -> Turn:
        """
        Stream the LLM reply into TTS. If `barge` fires mid-reply, CANCEL the in-flight generation and DISCARD
        the partial assistant turn (committed-as-interrupted, with only what was actually spoken). The next
        user utterance proceeds against the truthful, shortened history.
        """
        spoken_text_parts: list[str] = []
        interrupted = False

        token_gen = self._llm.respond(persona_instructions, self._history, user_text)
        try:
            async for token in token_gen:
                if barge is not None and barge():
                    # SmartTurnDetection says the user started a new turn: stop generating + stop speaking NOW.
                    interrupted = True
                    await token_gen.aclose()  # cancel the in-flight LLM stream (discards the rest of the turn)
                    break
                spoken_text_parts.append(token)
                await self._speak(token)
        finally:
            # Ensure the generator is closed even on an unexpected exit.
            await token_gen.aclose()

        spoken = "".join(spoken_text_parts).strip()
        return Turn(role="assistant", text=spoken, interrupted=interrupted)

    async def _speak(self, text: str) -> None:
        async for chunk in self._tts.synthesize(text):
            # Voice-consistency gate: refuse any chunk whose voice_id is not the session's canonical id.
            if chunk.voice_id != self._canonical_voice_id:
                raise VoiceConsistencyError(
                    f"TTS chunk voice_id {chunk.voice_id!r} != canonical {self._canonical_voice_id!r}"
                )
            self._result.audio_voice_ids.append(chunk.voice_id)
            if self._audio_sink is not None:
                await self._audio_sink(chunk)

    async def _deliver_cutoff(self, message: str) -> None:
        """Speak the in-persona cutoff line (still in the canonical voice), then the transport drops."""
        if message:
            await self._speak(message)
            cutoff_turn = Turn(role="assistant", text=message)
            self._history.append(cutoff_turn)
            await self._commit_turn(cutoff_turn)

    async def _commit_turn(self, turn: Turn) -> None:
        """Single-writer, idempotent write-back. The turn index is monotonic across the session/reconnects."""
        await self._transcript.write_turn(self._turn_index, turn)
        self._turn_index += 1


async def frames_from(chunks: list[bytes]) -> AsyncIterator[bytes]:
    """Helper: turn a list of byte frames into an async iterator (an utterance's audio)."""
    for c in chunks:
        await asyncio.sleep(0)
        yield c
