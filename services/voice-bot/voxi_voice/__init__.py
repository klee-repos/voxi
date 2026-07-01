"""
voxi_voice — the Voxi realtime voice pipeline (PLAN §6.3).

A vendor-agnostic Pipecat-style cascade (STT -> LLM -> ElevenLabs Voxi voice) with SmartTurnDetection
barge-in, a canonical persona injected once, a per-session scoped-token BFF tool bridge, idempotent
transcript write-back to eve (single writer), and a voice-minute hard cutoff. Runs with NO creds via the
pluggable provider fakes; swaps to real vendors + Pipecat SmallWebRTC behind the same interfaces.
"""

from .bff_bridge import (
    BffTransport,
    FakeBff,
    ScopedToken,
    ToolBridge,
    TranscriptWriter,
    turn_idempotency_key,
)
from .metering import CUTOFF_MESSAGE, MeterDecision, MeterEvent, VoiceMeter
from .persona import CANONICAL_VOXI_VOICE_ID, PersonaInjector, SessionPersona, VOXI_PERSONA
from .pipeline import (
    BargeInDetector,
    SessionResult,
    VoiceConsistencyError,
    VoicePipeline,
    frames_from,
)
from .providers import (
    DeepgramSTT,
    ElevenLabsTTS,
    FakeLLM,
    FakeSTT,
    FakeTTS,
    GeminiLLM,
    LLMProvider,
    STTProvider,
    Transcription,
    TtsChunk,
    TtsProvider,
    Turn,
)
from .transport import TransportConfig, build_pipecat_runner, pipecat_available

__all__ = [
    "BargeInDetector",
    "BffTransport",
    "CANONICAL_VOXI_VOICE_ID",
    "CUTOFF_MESSAGE",
    "DeepgramSTT",
    "ElevenLabsTTS",
    "FakeBff",
    "FakeLLM",
    "FakeSTT",
    "FakeTTS",
    "GeminiLLM",
    "LLMProvider",
    "MeterDecision",
    "MeterEvent",
    "PersonaInjector",
    "ScopedToken",
    "SessionPersona",
    "SessionResult",
    "STTProvider",
    "ToolBridge",
    "Transcription",
    "TranscriptWriter",
    "TransportConfig",
    "TtsChunk",
    "TtsProvider",
    "Turn",
    "VOXI_PERSONA",
    "VoiceConsistencyError",
    "VoiceMeter",
    "VoicePipeline",
    "build_pipecat_runner",
    "frames_from",
    "pipecat_available",
    "turn_idempotency_key",
]
