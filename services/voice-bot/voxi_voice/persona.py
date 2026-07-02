"""
The canonical Voxi persona for the realtime voice loop (PLAN §6.3 "Persona+context", §8.1).

This is the SAME persona the eve root agent uses (services/eve-agent/agent/instructions.md). The voice
bot is a separate, stateless sidecar — it never invents its own personality. It loads ONE canonical
persona block as session instructions on connect, so a spoken turn sounds identical to the written
description (TEST-PLAN conv-03 voice consistency is a brand promise, persona AND voice_id).

The persona is injected exactly once per session (`PersonaInjector` enforces the once-only contract;
re-injection on a reconnect would let context drift). Untrusted text (the user's words, OCR, web facts,
prior transcript) is data, never instructions — it can never re-open these rules. The persona itself
carries no emoji and no Adams trademark phrasing (G5).
"""

from __future__ import annotations

from dataclasses import dataclass

from .prompts import load_prompt

# The single canonical Voxi voice_id (PLAN §6.1 "ONE consistent voice"). The seam: TtsProvider
# implementations must echo whatever voice_id the session was minted with, and the pipeline asserts every
# spoken turn used THIS id (no silent vendor-fallback to a different timbre).
CANONICAL_VOXI_VOICE_ID = "voxi-dry-british-v1"

# Voxi's ElevenLabs voice. Decoupled from CANONICAL_VOXI_VOICE_ID above so a vendor failover can't trip the gate.
ELEVENLABS_VOXI_WIRE_VOICE_ID = "19STyYD15bswVz51nqLf"

# The persona prompt lives in `prompts/persona.md` (loaded verbatim). Kept terse on purpose: §8.1 demands
# short declaratives. It is the realtime-voice variant of instructions.md — same rules, trimmed of the
# photo-capture framing that the live loop inherits from the session it joins (the item record + prior
# transcript are loaded separately on connect).
VOXI_PERSONA = load_prompt("persona.md")


@dataclass(frozen=True)
class SessionPersona:
    """The fully-resolved persona block for one live session: the prompt + the bound voice_id."""

    instructions: str
    voice_id: str

    @staticmethod
    def canonical() -> "SessionPersona":
        return SessionPersona(instructions=VOXI_PERSONA, voice_id=CANONICAL_VOXI_VOICE_ID)


class PersonaInjector:
    """
    Guarantees the persona is injected exactly once per session (PLAN §6.3).

    The pipeline calls `inject()` at session start. A reconnect rebuilds the pipeline against the SAME
    injector instance for the session, and the second `inject()` is a no-op that returns the already-set
    persona — so context never drifts and we never pay to re-prime the LLM. `injected_count` is asserted
    by the tests (persona injected once, even across a reconnect).
    """

    def __init__(self, persona: SessionPersona | None = None) -> None:
        self._persona = persona or SessionPersona.canonical()
        self._injected = False
        self.injected_count = 0

    @property
    def persona(self) -> SessionPersona:
        return self._persona

    def inject(self) -> SessionPersona:
        if not self._injected:
            self._injected = True
            self.injected_count += 1
        return self._persona

    @property
    def already_injected(self) -> bool:
        return self._injected
