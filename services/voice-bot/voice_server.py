"""
Runnable Voxi realtime voice server (PLAN §6.3 — Transport: Pipecat SmallWebRTC).

A FastAPI/uvicorn app exposing the SmallWebRTC signalling handshake the app's `@pipecat-ai/client-js` +
`@pipecat-ai/react-native-small-webrtc-transport` speak:

  POST /offer  { sdp, type }  ->  { sdp, type }        # SDP offer -> SDP answer; spins up a live pipeline
  GET  /health                ->  { ok, ... }          # liveness + which vendor creds are present
  GET  /                      ->  ok

On each /offer it builds a per-connection Pipecat pipeline:
    mic audio -> Deepgram STT (nova-3) -> Gemini LLM (Guide persona + item context) ->
    ElevenLabs TTS (Voxi/George) -> bot audio, with Silero VAD for turn/barge-in.

The pipeline runs in a background task for the life of the peer connection. This is the SAME cascade the
transport-agnostic core (voxi_voice.pipeline) exercises with fakes; here it runs over real WebRTC media.

Boot:  DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOXI_VOICE_ID, GCP_PROJECT (+ gcloud login) in env.
Run:   uvicorn voice_server:app --host 0.0.0.0 --port 7071
       (or: python voice_server.py --port 7071)

The BFF (services/voxi-api/src/voice-routes.ts) mints a per-session connect URL that points the client here
after a voiceMin entitlement check; this server is the media plane, the BFF stays the only auth surface.
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from voxi_voice.persona import VOXI_PERSONA
from voxi_voice.telemetry import get_logger

log = get_logger("voxi-voice", role="voice")

app = FastAPI(title="voxi-voice")

# The RN small-webrtc client is a browser-origin peer; allow it to POST the SDP offer.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Keep a strong ref to each live connection so it isn't GC'd mid-call.
_connections: dict[str, object] = {}


class Offer(BaseModel):
    sdp: str
    type: str
    pc_id: str | None = None
    # Optional item context the BFF/app can pass so the Guide is grounded in the identified object.
    item_context: str | None = None


@app.get("/")
async def root() -> str:
    return "ok"


@app.get("/health")
async def health() -> dict:
    """Liveness + honest report of which vendor creds are present (never fakes success)."""
    return {
        "ok": True,
        "service": "voxi-voice",
        "deepgram": bool(os.getenv("DEEPGRAM_API_KEY")),
        "elevenlabs": bool(os.getenv("ELEVENLABS_API_KEY")),
        "voxi_voice_id": bool(os.getenv("ELEVENLABS_VOXI_VOICE_ID")),
        "gcp_project": os.getenv("GCP_PROJECT") or None,
        "live_connections": len(_connections),
    }


@app.post("/offer")
async def offer(body: Offer) -> dict:
    """
    SmallWebRTC signalling: accept the client's SDP offer, build the live pipeline against a fresh
    SmallWebRTCConnection, and return the SDP answer. Renegotiation reuses the same connection by pc_id.
    """
    from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection

    from voxi_voice.transport import build_pipeline_for_connection

    # Reuse an existing connection on renegotiation; otherwise create + wire a new pipeline.
    existing = _connections.get(body.pc_id) if body.pc_id else None
    if existing is not None:
        await existing.renegotiate(sdp=body.sdp, type=body.type)  # type: ignore[attr-defined]
        log.info("offer renegotiated", pc_id=body.pc_id)
        return existing.get_answer()  # type: ignore[attr-defined]

    connection = SmallWebRTCConnection(ice_servers=["stun:stun.l.google.com:19302"])
    await connection.initialize(sdp=body.sdp, type=body.type)

    @connection.event_handler("closed")
    async def _on_closed(conn) -> None:  # noqa: ANN001
        _connections.pop(conn.pc_id, None)
        log.info("connection closed", pc_id=conn.pc_id, live_connections=len(_connections))

    task, runner = build_pipeline_for_connection(
        connection,
        persona=VOXI_PERSONA,
        item_context=body.item_context or "",
    )

    import asyncio

    asyncio.create_task(runner.run(task))

    answer = connection.get_answer()
    _connections[answer["pc_id"]] = connection
    log.info("offer accepted", pc_id=answer["pc_id"], has_item_context=bool(body.item_context), live_connections=len(_connections))
    return answer


if __name__ == "__main__":
    import argparse

    import uvicorn

    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=int(os.getenv("VOICE_PORT", "7071")))
    args = ap.parse_args()
    log.info("voxi-voice listening", host=args.host, port=args.port)
    uvicorn.run(app, host=args.host, port=args.port)
