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

Boot:  DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, GCP_PROJECT (+ gcloud login) in env. (The voice id is baked in
       as ELEVENLABS_VOXI_WIRE_VOICE_ID, not an env knob.)
Run:   uvicorn voice_server:app --host 0.0.0.0 --port 7071
       (or: python voice_server.py --port 7071)

The BFF (services/voxi-api/src/voice-routes.ts) mints a per-session connect URL that points the client here
after a voiceMin entitlement check; this server is the media plane, the BFF stays the only auth surface.
"""

from __future__ import annotations

import asyncio
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from voxi_voice.bff_bridge import HttpxBff
from voxi_voice.persona import ELEVENLABS_VOXI_WIRE_VOICE_ID, VOXI_PERSONA
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
# The pipeline runner task per connection (F1 teardown cancels it on a new /offer for the same thread).
_tasks: dict[str, asyncio.Task] = {}
# F6-LEAK: the per-connection context-refresh task. Cancelled on WebRTC close so a dropped peer can't keep
# hammering /v1/voice/session/:connectId/context for 10 min against a connectId the BFF already refunded (404 storm).
_refresh_tasks: dict[str, asyncio.Task] = {}
# F1: one stream per item — threadId → the active pc_id. A new /offer for a thread with a live connection tears
# the old one down first, so a close+reopen can never leave two WebRTC peers + pipelines running.
_thread_connections: dict[str, str] = {}
# F5: the BFF transport for the grounded-context fetch (capability-auth'd by the connectId). Absent BFF_BASE_URL
# → None → the voice-bot fails open to persona-only (the Guide converses, just without item grounding).
_bff: HttpxBff | None = HttpxBff(os.getenv("BFF_BASE_URL", "")) if os.getenv("BFF_BASE_URL", "") else None


def _ice_server_config() -> list[dict]:
    """STUN + env-driven TURN (B1 root cause: STUN-only can't traverse a UDP-blocked network — the device's
    gathered candidates were all `tcp tcptype passive`, so ICE went `failed` and the RTVI data channel never
    opened). Returns dicts the /offer handler materializes as aiortc IceServer objects — SmallWebRTCConnection
    accepts list[str] OR list[RTCIceServer] (not dicts), and a string item is credential-less, so TURN auth
    requires the object form. TURN_URL is comma-separated (≥2 relays for redundancy); static creds for v1.
    Default-off (unset → STUN-only = the prior behavior, no regression)."""
    servers: list[dict] = [{"urls": "stun:stun.l.google.com:19302"}]
    turn_urls = [u.strip() for u in os.getenv("TURN_URL", "").split(",") if u.strip()]
    user, pwd = os.getenv("TURN_USER", ""), os.getenv("TURN_PASS", "")
    if turn_urls and user and pwd:
        for u in turn_urls:
            servers.append({"urls": u, "username": user, "credential": pwd})
    return servers


async def _tear_down(pc_id: str | None) -> None:
    """Best-effort teardown of one connection: cancel the pipeline task + close the WebRTC peer. Idempotent."""
    if not pc_id:
        return
    t = _tasks.pop(pc_id, None)
    if t is not None:
        t.cancel()
    rt = _refresh_tasks.pop(pc_id, None)
    if rt is not None:
        rt.cancel()
    conn = _connections.pop(pc_id, None)
    if conn is not None:
        try:
            await conn.close()  # type: ignore[attr-defined]
        except Exception as e:  # noqa: BLE001 — teardown must never block a new /offer
            log.info("teardown_close_failed", pc_id=pc_id, err=str(e))


class Offer(BaseModel):
    sdp: str
    type: str
    pc_id: str | None = None
    # ICE-restart renegotiation (transport.js negotiate→recreatePeerConnection): the client closed + recreated
    # its peer connection and POSTs a fresh offer with restart_pc=true. The server MUST restart the aiortc PC in
    # lockstep (connection.py:436 renegotiate(restart_pc=…)) or the two PCs desync → the "Cannot read property
    # 'setRemoteDescription'" asymmetry. Absent on initial offers (back-compat: None → False).
    restart_pc: bool | None = None
    # Optional item context the BFF/app can pass so the Guide is grounded in the identified object.
    item_context: str | None = None


class PatchOffer(BaseModel):
    """Trickle-ICE candidate flush — the RN transport PATCHes /offer with this body (transport.js
    flushIceCandidates, method 'PATCH'), NOT an SDP renegotiation. Renegotiation is the POST `negotiate()` path.
    Each candidate is {candidate, sdp_mid, sdp_mline_index}; forwarded to SmallWebRTCConnection.add_ice_candidate
    (connection.py:808). Without this handler the PATCH 405s and relay candidates never reach aiortc → ICE fails
    under restrictive NAT (the B1 scenario)."""

    pc_id: str
    candidates: list[dict]


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
        "voxi_voice_id": ELEVENLABS_VOXI_WIRE_VOICE_ID,  # baked-in, no env
        "gcp_project": os.getenv("GCP_PROJECT") or None,
        "live_connections": len(_connections),
    }


@app.post("/offer")
async def offer(body: Offer, request: Request) -> dict:
    """
    SmallWebRTC signalling: accept the client's SDP offer, build the live pipeline against a fresh
    SmallWebRTCConnection, and return the SDP answer. Renegotiation reuses the same connection by pc_id.
    F1: one stream per item — a new /offer for a thread with a live connection tears the old one down first.
    F5: the grounded item context is fetched from the BFF (capability = the connectId in ?session=), failing
    open to persona-only if the BFF has no reveal yet or is unreachable.
    """
    from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection

    from voxi_voice.transport import build_pipeline_for_connection

    # Materialize the ICE config once so we can LOG it (B1 diagnosability: confirm TURN is loaded per-connection
    # — a missing/typo'd TURN_URL silently degrades to STUN-only and ICE fails on UDP-blocked device networks).
    ice_config = _ice_server_config()
    has_turn = any("username" in s for s in ice_config)
    log.info("ice_servers_config", count=len(ice_config), has_turn=has_turn)

    thread_id = request.query_params.get("thread")
    connect_id = request.query_params.get("session")

    # Reuse an existing connection on renegotiation; otherwise create + wire a new pipeline.
    existing = _connections.get(body.pc_id) if body.pc_id else None
    if existing is not None:
        # Forward restart_pc (ICE-restart): the client recreated its PC and POSTs restart_pc=true; the server
        # restarts the aiortc PC in lockstep. A missed restart desyncs the two PCs (B2b).
        await existing.renegotiate(sdp=body.sdp, type=body.type, restart_pc=bool(body.restart_pc))  # type: ignore[attr-defined]
        log.info("offer renegotiated", pc_id=body.pc_id, restart_pc=bool(body.restart_pc))
        return existing.get_answer()  # type: ignore[attr-defined]

    # F1: one stream per item. A close+reopen (or a client crash) must not leave the old peer + pipeline live.
    if thread_id and thread_id in _thread_connections:
        await _tear_down(_thread_connections.pop(thread_id, None))

    # F5: fetch the server-owned grounded item context. The connectId is the capability; the BFF route is
    # capability-auth'd (no bearer). Fail-open: no context → persona-only voice.
    item_context = body.item_context or ""
    if not item_context and connect_id and _bff is not None:
        try:
            ctx = await _bff.fetch_context(connect_id)
            item_context = ctx.get("itemContext", "") if isinstance(ctx, dict) else ""
        except Exception as e:  # noqa: BLE001 — a context-fetch failure must never block voice
            log.info("context_fetch_failed", connect_id=connect_id, err=str(e))

    connection = SmallWebRTCConnection(ice_servers=[IceServer(**s) for s in ice_config])
    await connection.initialize(sdp=body.sdp, type=body.type)

    @connection.event_handler("closed")
    async def _on_closed(conn) -> None:  # noqa: ANN001
        pc = conn.pc_id
        _connections.pop(pc, None)
        _tasks.pop(pc, None)
        rt = _refresh_tasks.pop(pc, None)
        if rt is not None:
            rt.cancel()
        # Drop the thread→pc mapping ONLY if it still points at THIS pc (a newer /offer may have replaced it).
        if thread_id and _thread_connections.get(thread_id) == pc:
            _thread_connections.pop(thread_id, None)
        log.info("connection closed", pc_id=pc, live_connections=len(_connections))

    task, runner, refresh_task = build_pipeline_for_connection(
        connection,
        persona=VOXI_PERSONA,
        item_context=item_context,
        bff=_bff,
        connect_id=connect_id,
    )

    runner_task = asyncio.create_task(runner.run(task))

    answer = connection.get_answer()
    pc_id = answer["pc_id"]
    _connections[pc_id] = connection
    _tasks[pc_id] = runner_task
    if refresh_task is not None:
        _refresh_tasks[pc_id] = refresh_task
    if thread_id:
        _thread_connections[thread_id] = pc_id
    log.info("offer accepted", pc_id=pc_id, has_item_context=bool(item_context), live_connections=len(_connections))
    return answer


@app.patch("/offer")
async def patch_offer(body: PatchOffer) -> dict:
    """Trickle-ICE candidate flush (B2). The RN transport PATCHes /offer with {pc_id, candidates} — this is
    flushIceCandidates (transport.js:462-490), NOT SDP renegotiation (that's the POST negotiate() path). Each
    candidate dict {candidate, sdp_mid, sdp_mline_index} is converted to an aiortc RTCIceCandidate (the object
    form add_ice_candidate consumes — passing the raw dict was a silent regression: connection.py:808 reads
    candidate.sdpMid) and forwarded. Without this handler the PATCH 405s and relay candidates never reach
    aiortc → ICE fails under restrictive NAT. A closed/unknown peer is a soft-fail, never a 5xx."""
    from aiortc.sdp import candidate_from_sdp

    conn = _connections.get(body.pc_id)
    if conn is None:
        return {"ok": False, "error": "unknown_pc"}
    for c in body.candidates:
        try:
            # Mirror the reference SmallWebRTCRequestHandler.handle_patch_request: parse the SDP candidate string
            # into an RTCIceCandidate, then set the snake_case transport fields onto the camelCase attributes
            # aiortc's addIceCandidate reads (candidate.sdpMid / .sdpMLineIndex).
            candidate = candidate_from_sdp(c["candidate"])
            candidate.sdpMid = c.get("sdp_mid")
            candidate.sdpMLineIndex = c.get("sdp_mline_index")
            await conn.add_ice_candidate(candidate)  # type: ignore[attr-defined]
        except Exception as e:  # noqa: BLE001 — one bad candidate must not drop the rest of the flush
            log.info("add_ice_candidate_failed", pc_id=body.pc_id, err=str(e))
    return {"ok": True}



if __name__ == "__main__":
    import argparse

    import uvicorn

    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=int(os.getenv("VOICE_PORT", "7071")))
    args = ap.parse_args()
    log.info("voxi-voice listening", host=args.host, port=args.port)
    uvicorn.run(app, host=args.host, port=args.port)
