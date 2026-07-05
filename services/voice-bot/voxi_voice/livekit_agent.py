"""
Voxi voice bot on LiveKit Agents (replaces the pipecat SmallWebRTC transport).

The pipecat SmallWebRTC transport had an unrecoverable audio-reception bug (pipecat-ai #2755 plus a deeper
MediaStreamError that reproduced even on a clean aiortc↔voice-bot direct connection, no trackStatus). LiveKit
Agents owns the WebRTC media plane — the bot subscribes to the caller's mic + publishes TTS through LiveKit's
production-grade transport, so the SmallWebRTC audio bug is gone by construction.

This reuses, unchanged:
  - persona.py  → VOXI_PERSONA + ELEVENLABS_VOXI_WIRE_VOICE_ID (the canonical Guide + voice).
  - bff_bridge.HttpxBff.fetch_context(connect_id) → the F5 grounded item-context fetch (capability-auth'd by
    the connectId; fail-OPEN to persona-only if the BFF is unreachable / has no reveal yet).
  - prompts.render_prompt("item-context.md", ...) → the DATA-not-instructions wrapper for the grounded context.

The cascade is recomposed in the LiveKit Agent API: Deepgram nova-3 STT → OpenAI LLM → ElevenLabs TTS, with
the bundled Silero VAD for turn detection (always-on mic — the pipecat #2755 conclusion carries over).
"""

from __future__ import annotations

import json
import os
from typing import Any

from livekit import agents
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions
from livekit.plugins import deepgram, elevenlabs, openai

from .bff_bridge import HttpxBff
from .persona import ELEVENLABS_VOXI_WIRE_VOICE_ID, VOXI_PERSONA
from .prompts import render_prompt


def _instructions_for(item_context: str) -> str:
    """The Agent's instructions: the canonical persona + the grounded item context (wrapped as DATA). When no
    context is available (BFF unreachable / no reveal yet), persona-only — the Guide converses generically."""
    if not item_context:
        return VOXI_PERSONA
    return render_prompt("item-context.md", {"persona": VOXI_PERSONA, "item_context": item_context})


def _connect_id_from_room(room: Any) -> str | None:
    """The caller's participant carries the BFF-minted {connectId, threadId, userId} in its metadata (the BFF
    token mint sets it). Best-effort: if no participant / no metadata yet, return None (persona-only)."""
    try:
        participants = getattr(room, "remote_participants", {}) or {}
        for p in participants.values():
            meta = getattr(p, "metadata", None) or ""
            if not meta:
                continue
            try:
                data = json.loads(meta)
            except Exception:  # noqa: BLE001 — a participant's metadata may be non-JSON (LiveKit attributes etc.)
                continue
            cid = data.get("connectId")
            if isinstance(cid, str) and cid:
                return cid
    except Exception:  # noqa: BLE001 — context-read must never block voice
        return None
    return None


async def _fetch_item_context(connect_id: str | None) -> str:
    """F5: fetch the grounded item context from the BFF (capability = connectId). Fail-open → empty string."""
    if not connect_id:
        return ""
    base = os.getenv("BFF_BASE_URL", "")
    if not base:
        return ""
    bff = HttpxBff(base)
    try:
        ctx = await bff.fetch_context(connect_id)
    except Exception:  # noqa: BLE001 — fail-open, never block voice
        return ""
    return (ctx.get("itemContext", "") if isinstance(ctx, dict) else "") or ""


class VoxiAgent(Agent):
    """The Guide. Instructions = the canonical persona + the grounded item context (set at session start)."""


async def entrypoint(ctx: JobContext) -> None:
    """One bot per room. Connect → fetch the item context (best-effort) → start the cascade."""
    await ctx.connect()

    # Best-effort F5 grounding: read the connectId from the caller's metadata + fetch the item context.
    connect_id = _connect_id_from_room(ctx.room)
    item_context = await _fetch_item_context(connect_id)

    session = AgentSession(
        stt=deepgram.STT(
            model="nova-3",
            interim_results=True,
            punctuate=True,
            smart_format=True,
        ),
        llm=openai.LLM(
            model=os.getenv("VOXI_VOICE_MODEL", "gpt-4o-mini"),
            api_key=os.getenv("OPENAI_API_KEY"),
        ),
        tts=elevenlabs.TTS(
            voice_id=ELEVENLABS_VOXI_WIRE_VOICE_ID,
            model="eleven_turbo_v2_5",
            api_key=os.getenv("ELEVENLABS_API_KEY"),
        ),
    )

    await session.start(
        agent=VoxiAgent(instructions=_instructions_for(item_context)),
        room=ctx.room,
    )


def worker_options() -> WorkerOptions:
    """The Worker: connects to the LiveKit server + dispatches one entrypoint per room."""
    return WorkerOptions(
        entrypoint_fnc=entrypoint,
        # The Worker authenticates to LiveKit with LIVEKIT_API_KEY/SECRET (env). LiveKit's agent dispatch
        # fires the entrypoint when a caller joins a room with an agent-grant token (the BFF mints it).
        ws_url=os.getenv("LIVEKIT_URL", "ws://localhost:7880"),
        api_key=os.getenv("LIVEKIT_API_KEY", "devkey"),
        api_secret=os.getenv("LIVEKIT_API_SECRET", "secret"),
        # The Worker's HTTP API default is :8081, which collides with Metro (the JS bundle port). Pin a free
        # port (env-overridable) so dev + the bundle server coexist.
        port=int(os.getenv("LIVEKIT_AGENT_PORT", "8089")),
    )


def main() -> None:
    agents.cli.run_app(worker_options())
