"""
Pipecat transport seam (PLAN §6.3 "Transport: Pipecat SmallWebRTC").

The pipeline core (`pipeline.py`) is transport-agnostic. This module is the ONLY place that knows about
Pipecat, and Pipecat is an OPTIONAL dependency: importing this module never fails just because Pipecat is
absent (the sandbox has no creds and no media stack). `build_pipecat_runner()` raises a clear, actionable
error if Pipecat is not installed, instead of crashing at import time — so the test suite, which exercises
the core loop with fakes, never needs Pipecat.

When Pipecat IS present (a real Cloud Run deploy), this wires:
  - SmallWebRTCTransport (P2P, aiortc, no SFU — best GCP fit for 1:1) as the default, Daily as the fallback,
  - SmartTurnDetection as the end-of-turn / barge-in classifier (fewer false barge-ins than VAD silence),
  - the cascade providers (real Deepgram/Gemini STT, Gemini/Claude LLM, ElevenLabs Flash v2.5 TTS) behind
    the SAME STTProvider/LLMProvider/TtsProvider protocols the fakes implement.
"""

from __future__ import annotations

from dataclasses import dataclass
from importlib.util import find_spec
from typing import Literal

from .persona import ELEVENLABS_VOXI_WIRE_VOICE_ID
from .prompts import render_prompt


def pipecat_available() -> bool:
    """True iff the Pipecat package can be imported. Used to skip the live transport path with no creds."""
    return find_spec("pipecat") is not None


@dataclass(frozen=True)
class TransportConfig:
    """Which WebRTC transport to use. SmallWebRTC is the default (self-hosted P2P); Daily is the fallback."""

    kind: Literal["smallwebrtc", "daily"] = "smallwebrtc"
    # SmartTurnDetection on by default: an LLM-based end-of-turn classifier (§6.3) rather than a raw VAD
    # silence threshold — fewer false barge-ins on mid-thought pauses, which suits a persona voice product.
    smart_turn_detection: bool = True
    # Push-to-hold / tap-to-toggle by default (PLAN §6.3 mic model, resolves D6). VAD barge-in is paid-tier.
    mic_mode: Literal["push_to_hold", "vad"] = "push_to_hold"


def build_pipecat_runner(config: TransportConfig | None = None):
    """
    Construct the live Pipecat runner. Importing Pipecat lazily means this file imports fine with no deps.

    Raises a clear RuntimeError if Pipecat is missing — the caller (a real deploy) is expected to have it;
    the test suite never calls this, it drives `VoicePipeline` directly with fakes.
    """
    config = config or TransportConfig()
    if not pipecat_available():
        raise RuntimeError(
            "Pipecat is not installed in this environment. The transport seam is optional and "
            "credential/media-stack-gated; install pipecat-ai (and provide STT/LLM/TTS creds) to run the "
            "live SmallWebRTC transport. The core pipeline (voxi_voice.pipeline) runs and is tested without it."
        )
    # Real wiring is built PER CONNECTION in `build_pipeline_for_connection` (it needs the live
    # SmallWebRTCConnection from the /offer handshake). This function stays as the config validator +
    # capability probe; the server (voice_server.py) calls the per-connection builder below.
    return config


def build_pipeline_for_connection(
    connection,
    *,
    persona: str,
    item_context: str = "",
    config: "TransportConfig | None" = None,
):
    """
    Build a live Pipecat PipelineTask for one SmallWebRTC connection: mic audio in -> Deepgram STT ->
    Gemini LLM (Guide persona + item context) -> ElevenLabs TTS (Voxi/George voice) -> bot audio out, with
    Silero VAD for turn/barge-in detection. Returns (task, runner) ready to run.

    Imported lazily and only when Pipecat + the vendor services are installed (a real deploy). All creds come
    from the environment; each service fails loudly if its key is missing.
    """
    import os

    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport, TransportParams

    config = config or TransportConfig()

    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer() if config.smart_turn_detection else None,
        ),
    )

    stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"], model="nova-3")
    el_voice = ELEVENLABS_VOXI_WIRE_VOICE_ID  # Voxi's voice
    tts = ElevenLabsTTSService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        voice_id=el_voice,
        model="eleven_flash_v2_5",
    )

    system = persona
    if item_context:
        system = render_prompt("item-context.md", {"persona": persona, "item_context": item_context})

    llm = _build_vertex_llm(system)

    # Universal LLM context (persona seeded as the system message; STT user turns + LLM replies aggregate in).
    context = LLMContext(messages=[{"role": "system", "content": system}])
    context_aggregator = LLMContextAggregatorPair(context)

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            context_aggregator.user(),
            llm,
            tts,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )
    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))
    runner = PipelineRunner(handle_sigint=False)
    return task, runner


def _build_vertex_llm(system_instruction: str):
    """
    Gemini-on-Vertex LLM service authed by the gcloud CLI token (this env has no service-account JSON / ADC).

    pipecat's GoogleVertexLLMService only accepts a service-account JSON or ADC, so we subclass it and override
    `create_client()` to build the genai client with an OAuth2 token from `gcloud auth print-access-token` —
    the SAME auth the vision cascade and the verified GeminiLLM provider use. Fails loudly if gcloud is absent.
    """
    import os

    from google import genai
    from google.oauth2.credentials import Credentials
    from pipecat.services.google.vertex.llm import GoogleVertexLLMService

    from .providers import _gcloud_access_token

    class _GcloudVertexLLM(GoogleVertexLLMService):
        def _get_credentials(self, credentials=None, credentials_path=None):  # noqa: ANN001
            return Credentials(token=_gcloud_access_token())

        def create_client(self):
            self._client = genai.Client(
                vertexai=True,
                credentials=Credentials(token=_gcloud_access_token()),
                project=self._project_id,
                location=self._location,
            )

    return _GcloudVertexLLM(
        credentials="{}",  # ignored — our override supplies the gcloud-token credentials
        project_id=os.environ["GCP_PROJECT"],
        location=os.environ.get("GEMINI_LOCATION", "global"),
        model=os.environ.get("GEMINI_MODEL", "gemini-3.5-flash"),
        system_instruction=system_instruction,
    )
