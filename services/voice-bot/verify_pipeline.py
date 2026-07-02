"""
Server-side, browser-free proof that the Voxi voice cascade is REAL (no fakes, no stubs forcing green).

It drives the exact three vendor hops the live SmallWebRTC pipeline uses, in order:

  1. ElevenLabs TTS synthesizes a spoken question WAV  ("What is this Canon camera?")   [makes the input]
  2. Deepgram STT (real DeepgramSTT provider) transcribes that WAV  -> a real transcript
  3. Gemini LLM (real GeminiLLM provider, Guide persona) answers the transcript -> a real reply
  4. ElevenLabs TTS (real ElevenLabsTTS provider) synthesizes the reply -> real audio bytes (duration > 0)

This exercises the SAME provider classes (DeepgramSTT / GeminiLLM / ElevenLabsTTS) the transport wires,
behind the SAME Protocols the fakes implement — so a green here means the cascade is real end to end,
independent of a live WebRTC mic.

Run from the voice-bot dir with creds loaded:
    set -a; source ../../.env.local; set +a
    ./.venv/bin/python verify_pipeline.py
"""

from __future__ import annotations

import asyncio
import struct
import sys
import wave

from voxi_voice import (
    CANONICAL_VOXI_VOICE_ID,
    DeepgramSTT,
    ElevenLabsTTS,
    GeminiLLM,
    Transcription,
    Turn,
)
from voxi_voice.persona import VOXI_PERSONA

QUESTION = "What is this Canon camera?"
ITEM_CONTEXT = (
    "Identified object: Canon AE-1, a 35mm SLR film camera, released 1976. "
    "Confidence band: CONFIDENT. Make: Canon. Model: AE-1. Year: 1976."
)


def _wav_duration_seconds(audio: bytes) -> float:
    """Duration of a WAV blob (or a rough MP3 estimate) — proof the TTS produced real, non-empty audio."""
    if audio[:4] == b"RIFF":
        import io

        with wave.open(io.BytesIO(audio), "rb") as w:
            return w.getnframes() / float(w.getframerate() or 1)
    # MP3 (default flash output): estimate from CBR 128kbps if it's not a WAV.
    return len(audio) * 8 / 128_000.0


async def _frames(audio: bytes, chunk: int = 4096):
    """Stream a WAV blob as the async byte frames the STTProvider consumes (mimics push-to-hold mic frames)."""
    for i in range(0, len(audio), chunk):
        await asyncio.sleep(0)
        yield audio[i : i + chunk]


async def main() -> int:
    print("── Voxi voice cascade verification (real Deepgram + Gemini + ElevenLabs) ──\n")

    # ---- 0. Make a spoken-question WAV with ElevenLabs (record-free input). ----
    tts_wav = ElevenLabsTTS(voice_id=CANONICAL_VOXI_VOICE_ID, output_format="wav_24000")
    q_audio = b"".join([c.audio async for c in tts_wav.synthesize(QUESTION)])
    assert q_audio[:4] == b"RIFF", "expected a WAV from ElevenLabs"
    print(f"[0] Input WAV synthesized (ElevenLabs): {len(q_audio)} bytes, "
          f"{_wav_duration_seconds(q_audio):.2f}s of spoken '{QUESTION}'")

    # ---- 1. Deepgram STT: WAV -> transcript. ----
    stt = DeepgramSTT()
    finals: list[Transcription] = [t async for t in stt.transcribe(_frames(q_audio)) if t.is_final]
    transcript = finals[-1].text if finals else ""
    print(f"[1] Deepgram STT transcript: {transcript!r}")
    assert transcript.strip(), "STT returned an empty transcript — vendor path is not real"

    # ---- 2. Gemini LLM (Guide persona + item context): transcript -> reply. ----
    llm = GeminiLLM(item_context=ITEM_CONTEXT)
    history: list[Turn] = []
    reply = "".join([tok async for tok in llm.respond(VOXI_PERSONA, history, transcript)])
    print(f"[2] Gemini LLM reply ({len(reply)} chars):\n    {reply.strip()}")
    assert reply.strip(), "LLM returned an empty reply — vendor path is not real"

    # ---- 3. ElevenLabs TTS: reply -> audio bytes (duration > 0). ----
    tts = ElevenLabsTTS(voice_id=CANONICAL_VOXI_VOICE_ID, output_format="wav_24000")
    chunks = [c async for c in tts.synthesize(reply.strip())]
    out_audio = b"".join(c.audio for c in chunks)
    dur = _wav_duration_seconds(out_audio)
    # Voice-consistency: every chunk carries the canonical voice_id (the pipeline gate would reject otherwise).
    voice_ids = {c.voice_id for c in chunks}
    print(f"[3] ElevenLabs TTS reply audio: {len(out_audio)} bytes, {dur:.2f}s, "
          f"voice_id(s)={voice_ids}")
    assert out_audio[:4] == b"RIFF" and dur > 0.0, "TTS produced no real audio"
    assert voice_ids == {CANONICAL_VOXI_VOICE_ID}, "voice_id drift — consistency gate would reject"

    print("\n✓ PASS — STT→LLM→TTS is REAL end to end (no fakes).")
    print(f"    transcript : {transcript!r}")
    print(f"    llm_reply  : {reply.strip()[:200]}")
    print(f"    tts_out    : {len(out_audio)} bytes, {dur:.2f}s, voice={CANONICAL_VOXI_VOICE_ID}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
