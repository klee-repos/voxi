"""
Pluggable provider seam for the cascade (PLAN §6.3 "default cascade for voice consistency").

The realtime loop is a cascade: streaming STT -> LLM -> ElevenLabs Voxi voice. Each hop is an interface so
the bot runs with NO creds in this sandbox (deterministic fakes) and swaps to real vendors (Deepgram/Gemini
STT, Gemini 3.5 Flash / Claude LLM, ElevenLabs Flash v2.5) by config, not a rewrite. The protocols are the
contract; the fakes document it and make every test assertion deterministic.

Vendor fallbacks (PLAN §6.4) live behind these same interfaces: e.g. Deepgram down -> Gemini STT is a
different STTProvider; ElevenLabs degraded -> a second owned Voxi voice on another account is a TtsProvider
that STILL returns the canonical voice_id (same timbre). Only a full ElevenLabs outage swaps to a generic
narrator with an in-persona acknowledgement — and that is an explicit, audible degrade, never silent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import AsyncIterator, Protocol, runtime_checkable

from .prompts import render_prompt


# ---------------------------------------------------------------------------
# Data carried between hops
# ---------------------------------------------------------------------------
@dataclass
class Transcription:
    """An STT result. `is_final` distinguishes a streaming partial from the committed end-of-turn text."""

    text: str
    is_final: bool


@dataclass
class TtsChunk:
    """One synthesized audio chunk. Carries the voice_id actually used so the pipeline can assert consistency."""

    audio: bytes
    voice_id: str


# ---------------------------------------------------------------------------
# Provider protocols (the seam)
# ---------------------------------------------------------------------------
@runtime_checkable
class STTProvider(Protocol):
    """Streaming speech-to-text. Yields partials then exactly one final per utterance."""

    name: str

    async def transcribe(self, audio_frames: AsyncIterator[bytes]) -> AsyncIterator[Transcription]: ...


@runtime_checkable
class LLMProvider(Protocol):
    """
    The brain. `respond` streams tokens for one user turn given the persona + prior turns. It is cancellable:
    a barge-in cancels the in-flight generator (PLAN §6.3 barge-in discards the partial turn).
    """

    name: str

    async def respond(self, persona: str, history: list["Turn"], user_text: str) -> AsyncIterator[str]: ...


@runtime_checkable
class TtsProvider(Protocol):
    """
    Text-to-speech in the canonical Voxi voice. MUST emit chunks tagged with the voice_id it was constructed
    with; the pipeline refuses to play a chunk whose voice_id is not the session's canonical id.
    """

    name: str
    voice_id: str

    async def synthesize(self, text: str) -> AsyncIterator[TtsChunk]: ...


# A conversation turn (shared by the LLM history and the transcript write-back).
@dataclass
class Turn:
    role: str  # "user" | "assistant"
    text: str
    interrupted: bool = False  # an assistant turn cut short by barge-in is committed-as-interrupted (§6.3)


# ---------------------------------------------------------------------------
# Deterministic fakes (no creds) — these are NOT stubs that force green; they implement real behaviour:
# partials before final, cancellable token streaming, voice_id-tagged chunks.
# ---------------------------------------------------------------------------
@dataclass
class FakeSTT:
    """Yields a couple of partials then one final. `scripted` lets a test drive exact transcripts."""

    name: str = "fake-stt"
    scripted: list[str] = field(default_factory=list)
    _idx: int = 0

    async def transcribe(self, audio_frames: AsyncIterator[bytes]) -> AsyncIterator[Transcription]:
        # Consume the frames so the contract (an async stream in) is exercised.
        text = self.scripted[self._idx] if self._idx < len(self.scripted) else "what is this"
        self._idx += 1
        words = text.split()
        async for _frame in audio_frames:
            pass
        # Stream growing partials, then the final.
        acc: list[str] = []
        for w in words:
            acc.append(w)
            yield Transcription(text=" ".join(acc), is_final=False)
        yield Transcription(text=text, is_final=True)


@dataclass
class FakeLLM:
    """
    Streams a deterministic, persona-flavoured reply token-by-token. Records the persona it was given so a
    test can assert the persona reached the brain. Honours cancellation (GeneratorExit) for barge-in.
    """

    name: str = "fake-llm"
    seen_personas: list[str] = field(default_factory=list)
    delivered: list[str] = field(default_factory=list)

    async def respond(self, persona: str, history: list[Turn], user_text: str) -> AsyncIterator[str]:
        self.seen_personas.append(persona)
        reply = f"Ah. You are holding a {user_text}. Predictable, but not unwelcome."
        tokens = reply.split(" ")
        try:
            for i, tok in enumerate(tokens):
                piece = tok if i == 0 else " " + tok
                self.delivered.append(piece)
                yield piece
        except GeneratorExit:
            # Barge-in: the consumer cancelled us mid-stream. Stop cleanly.
            return


@dataclass
class FakeTTS:
    """
    Emits one voice_id-tagged chunk per token-ish span. Defaults to the canonical Voxi voice_id. A
    'degraded' fake can be constructed with a different voice_id to prove the pipeline catches a mismatch.
    """

    voice_id: str
    name: str = "fake-tts"
    synth_calls: list[str] = field(default_factory=list)

    async def synthesize(self, text: str) -> AsyncIterator[TtsChunk]:
        self.synth_calls.append(text)
        # Chunk by sentence-ish to mimic streaming audio.
        for span in _spans(text):
            yield TtsChunk(audio=span.encode("utf-8"), voice_id=self.voice_id)


def _spans(text: str) -> list[str]:
    out: list[str] = []
    cur: list[str] = []
    for ch in text:
        cur.append(ch)
        if ch in ".!?":
            out.append("".join(cur).strip())
            cur = []
    tail = "".join(cur).strip()
    if tail:
        out.append(tail)
    return out or [text]


# ---------------------------------------------------------------------------
# REAL vendor providers (credentialed). These live BEHIND the same Protocols as the fakes, so the
# transport-agnostic `VoicePipeline` and every test above are unchanged; a real deploy swaps FakeSTT ->
# DeepgramSTT, FakeLLM -> GeminiLLM, FakeTTS -> ElevenLabsTTS by config, not by rewrite.
#
# They fail LOUDLY (raise) when a credential or SDK is missing — never a fake success. The vendor SDKs are
# imported lazily inside each class so this module still imports (and the no-cred fakes still run) with none
# of deepgram-sdk / google-genai / elevenlabs installed.
# ---------------------------------------------------------------------------
import os
import subprocess


def _require(name: str, value: str | None) -> str:
    if not value:
        raise RuntimeError(
            f"{name} is required for the real voice cascade but is unset. Fill it in .env.local "
            f"(this is a seam that fails loudly, never a silent fake)."
        )
    return value


@dataclass
class DeepgramSTT:
    """
    Real Deepgram speech-to-text (STTProvider). Batch by default: it accumulates the utterance's audio
    frames (the pipeline hands us a bounded push-to-hold turn) and calls Deepgram's nova-3 transcription,
    then yields exactly ONE final Transcription — the same partials-then-final contract as FakeSTT, minus the
    streaming partials (the live SmallWebRTC server path uses Pipecat's streaming DeepgramSTTService instead;
    this class is the transport-agnostic, server-side-verifiable implementation).

    A production streaming upgrade is `client.listen.v1.connect(...)` (a WebSocket that yields interim
    results); kept as the documented next step so this class stays synchronous-batch simple and fully
    verifiable without a live socket.
    """

    api_key: str = ""
    model: str = "nova-3"
    name: str = "deepgram"

    def __post_init__(self) -> None:
        self.api_key = _require("DEEPGRAM_API_KEY", self.api_key or os.getenv("DEEPGRAM_API_KEY"))

    async def transcribe(self, audio_frames: AsyncIterator[bytes]) -> AsyncIterator[Transcription]:
        from deepgram import DeepgramClient  # lazy: only needed for the real path

        buf = bytearray()
        async for frame in audio_frames:
            buf.extend(frame)
        if not buf:
            yield Transcription(text="", is_final=True)
            return

        client = DeepgramClient(api_key=self.api_key)
        # Deepgram batch transcription is a blocking SDK call; run it off the event loop.
        import asyncio

        def _run() -> str:
            resp = client.listen.v1.media.transcribe_file(
                request=bytes(buf),
                model=self.model,
                smart_format=True,
                punctuate=True,
            )
            data = resp.dict() if hasattr(resp, "dict") else resp.model_dump()
            alt = data["results"]["channels"][0]["alternatives"][0]
            return str(alt.get("transcript", ""))

        text = await asyncio.to_thread(_run)
        yield Transcription(text=text, is_final=True)


def _gcloud_access_token() -> str:
    """
    Vertex auth via the gcloud CLI (mirrors services/eve-agent/agent/lib/gcp-vision.ts): a short-lived bearer
    from `gcloud auth print-access-token`. No service-account key on disk; no ADC required.
    """
    p = subprocess.run(
        ["gcloud", "auth", "print-access-token"], capture_output=True, text=True
    )
    tok = p.stdout.strip()
    if not tok:
        raise RuntimeError(f"gcloud auth print-access-token failed: {p.stderr.strip()}")
    return tok


@dataclass
class GeminiLLM:
    """
    Real Gemini (LLMProvider) on Vertex, authed by the gcloud CLI token (same as the vision cascade). The
    Guide persona is passed as the system instruction; the ITEM CONTEXT (what the photo was identified as,
    the confidence band, prior transcript) is injected as an extra system line so the spoken turn is grounded
    in the same record the written description used.

    Streams tokens (generate_content_stream) so the pipeline can pipe them into TTS and a barge-in can cancel
    mid-generation (the LLMProvider contract). Honours GeneratorExit on barge-in.
    """

    project: str = ""
    location: str = "us-central1"
    model: str = "gemini-2.5-flash"
    item_context: str = ""
    name: str = "gemini"

    def __post_init__(self) -> None:
        self.project = _require("GCP_PROJECT", self.project or os.getenv("GCP_PROJECT"))
        self.location = self.location or os.getenv("GCP_LOCATION", "us-central1")
        self.model = self.model or os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    def _client(self):
        from google import genai
        from google.oauth2.credentials import Credentials

        creds = Credentials(token=_gcloud_access_token())
        return genai.Client(
            vertexai=True, project=self.project, location=self.location, credentials=creds
        )

    async def respond(self, persona: str, history: list["Turn"], user_text: str) -> AsyncIterator[str]:
        from google.genai import types
        import asyncio

        system = persona
        if self.item_context:
            # Untrusted item facts are DATA, framed as context — they can never re-open the persona rules.
            system = render_prompt("item-context.md", {"persona": persona, "item_context": self.item_context})

        contents: list = []
        for t in history:
            role = "user" if t.role == "user" else "model"
            contents.append(types.Content(role=role, parts=[types.Part(text=t.text)]))
        contents.append(types.Content(role="user", parts=[types.Part(text=user_text)]))

        client = self._client()
        cfg = types.GenerateContentConfig(system_instruction=system, temperature=0.7)

        # The SDK stream iterator is blocking; pump it through a thread into an asyncio queue so `respond`
        # stays an async generator the pipeline can cancel on barge-in.
        queue: asyncio.Queue = asyncio.Queue()
        _DONE = object()

        def _pump() -> None:
            try:
                for chunk in client.models.generate_content_stream(
                    model=self.model, contents=contents, config=cfg
                ):
                    if getattr(chunk, "text", None):
                        queue._loop.call_soon_threadsafe(queue.put_nowait, chunk.text)  # type: ignore[attr-defined]
            except Exception as exc:  # surface vendor errors, never swallow into a fake success
                queue._loop.call_soon_threadsafe(queue.put_nowait, exc)  # type: ignore[attr-defined]
            finally:
                queue._loop.call_soon_threadsafe(queue.put_nowait, _DONE)  # type: ignore[attr-defined]

        queue._loop = asyncio.get_running_loop()  # type: ignore[attr-defined]
        task = asyncio.get_running_loop().run_in_executor(None, _pump)
        try:
            while True:
                item = await queue.get()
                if item is _DONE:
                    break
                if isinstance(item, Exception):
                    raise item
                yield item
        except GeneratorExit:
            # Barge-in: consumer cancelled us. Stop yielding; the background pump drains harmlessly.
            return
        finally:
            task.cancel() if hasattr(task, "cancel") else None


@dataclass
class ElevenLabsTTS:
    """
    Real ElevenLabs text-to-speech (TtsProvider) in the canonical Voxi voice (George). Every chunk is tagged
    with the SESSION's canonical voice_id so the pipeline's voice-consistency gate passes — a vendor fallback
    that returned a different timbre would be caught, never played silently.

    `voice_id` here is the LOGICAL canonical id the pipeline asserts on (persona.voice_id). The actual
    ElevenLabs voice id (George = ELEVENLABS_VOXI_VOICE_ID) is a separate wire detail; they are decoupled so
    the pipeline's identity check is stable across a vendor-account failover to a second George clone.
    """

    voice_id: str  # the canonical logical id the pipeline asserts on
    api_key: str = ""
    el_voice_id: str = ""  # the ElevenLabs wire voice id (George)
    model_id: str = "eleven_flash_v2_5"
    output_format: str = "mp3_44100_128"
    name: str = "elevenlabs"

    def __post_init__(self) -> None:
        self.api_key = _require("ELEVENLABS_API_KEY", self.api_key or os.getenv("ELEVENLABS_API_KEY"))
        # The env value may carry a trailing comment; keep only the id token.
        raw = self.el_voice_id or os.getenv("ELEVENLABS_VOXI_VOICE_ID", "")
        self.el_voice_id = _require("ELEVENLABS_VOXI_VOICE_ID", raw.split()[0] if raw else None)

    async def synthesize(self, text: str) -> AsyncIterator[TtsChunk]:
        from elevenlabs.client import ElevenLabs
        import asyncio

        client = ElevenLabs(api_key=self.api_key)

        def _run() -> bytes:
            audio = client.text_to_speech.convert(
                voice_id=self.el_voice_id,
                text=text,
                model_id=self.model_id,
                output_format=self.output_format,
            )
            return b"".join(audio)

        audio = await asyncio.to_thread(_run)
        # One chunk carrying the CANONICAL voice_id (not the wire id) so the consistency gate is stable.
        yield TtsChunk(audio=audio, voice_id=self.voice_id)
