"""
Deterministic LiveKit voice-agent validation — the AUDIO PLANE, with NO device / no phone.

This is the voice equivalent of spikes/e2e-live-http.ts: it exercises the REAL media path the migration
introduced (pipecat SmallWebRTC → LiveKit Agents, see voxi_voice/livekit_agent.py). A headless LiveKit
*caller* (the `livekit.rtc` Python SDK) stands in for the app's @livekit/react-native Room:

  1. mint a caller token carrying the agent-dispatch grant + the {connectId,threadId,userId} metadata the
     BFF sets at mint (voice-routes.ts),
  2. join the room and publish a synthetic sine-wave mic track (so the bot's Deepgram STT has real audio),
  3. assert the voice-bot WORKER is dispatched into the room and joins as a participant — this is the whole
     point of LiveKit Agents: dispatch → entrypoint() → AgentSession (Deepgram→OpenAI→ElevenLabs) starts.

The bot joining IS the deterministic verdict (exit 0 = PASS, non-zero = FAIL) — it proves dispatch + the
worker's entrypoint ran end-to-end over the real WebRTC transport. The cascade running (transcription,
TTS) additionally needs vendor keys and is observed in the worker log, not asserted here.

Prereqs (all started by scripts/dev.sh): the LiveKit dev server on :7880 + the bot worker (livekit_bot.py).
Run:
    LIVEKIT_API_SECRET="voxi-livekit-dev-secret-32chars-ok" \
      services/voice-bot/.venv/bin/python services/voice-bot/verify_livekit_agent.py
"""
from __future__ import annotations

import asyncio
import math
import os
import sys
import time

from livekit import rtc
from livekit.api import AccessToken, VideoGrants

URL = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
KEY = os.getenv("LIVEKIT_API_KEY", "devkey")
SECRET = os.getenv("LIVEKIT_API_SECRET", "secret")
# A unique room per run — a fixed room can collide with a stale/lingering participant from a prior run.
ROOM = os.getenv("LIVEKIT_VALIDATE_ROOM", f"voxi-validate-{int(time.time())}")
DISPATCH_TIMEOUT_S = float(os.getenv("LIVEKIT_VALIDATE_TIMEOUT_S", "15"))


async def run() -> bool:
    token = (
        AccessToken(KEY, SECRET)
        .with_identity("validator")
        # Mirrors the BFF token mint (voice-routes.ts): the metadata carries the F5 connectId capability.
        .with_metadata(f'{{"connectId":"validate","threadId":"{ROOM}","userId":"validator"}}')
        .with_grants(
            VideoGrants(
                room_join=True,
                room=ROOM,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
                agent=True,  # triggers LiveKit to dispatch the voice-bot Worker into this room
            )
        )
        .to_jwt()
    )

    room = rtc.Room()
    bot_joined = asyncio.Event()

    @room.on("participant_connected")
    def _on_participant(p: rtc.RemoteParticipant) -> None:
        # Any participant that is not us is the dispatched bot.
        if p.identity != "validator":
            print(f"[validator] bot participant joined: identity={p.identity!r}")
            bot_joined.set()

    await room.connect(URL, token)
    print(f"[validator] connected to room {ROOM!r}; local_identity={room.local_participant.identity!r}")

    # A pre-existing bot may already be in the room by the time our handler is registered — check the roster.
    if any(p.identity != "validator" for p in room.remote_participants.values()):
        bot_joined.set()

    # Publish a 440Hz sine wave as the caller's mic so the bot's STT has audio to transcribe.
    source = rtc.AudioSource(48000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("validator-mic", source)
    pub = await room.local_participant.publish_track(track, rtc.TrackPublishOptions())
    print(f"[validator] published sine-wave mic track; sid={pub.sid}")

    async def stream_sine() -> None:
        sample_rate, frame_dur, t = 48000, 0.02, 0.0
        while True:
            samples = bytearray()
            for i in range(int(sample_rate * frame_dur)):
                v = int(32767 * 0.3 * math.sin(2 * math.pi * 440 * (t + i / sample_rate)))
                samples += v.to_bytes(2, "little", signed=True)
            await source.capture_frame(rtc.AudioFrame(bytes(samples), sample_rate, 1, len(samples) // 2))
            t += frame_dur
            await asyncio.sleep(frame_dur)

    sine_task = asyncio.create_task(stream_sine())
    passed = False
    try:
        await asyncio.wait_for(bot_joined.wait(), timeout=DISPATCH_TIMEOUT_S)
        print("[validator] PASS: the voice-bot was dispatched and joined the room (LiveKit agent dispatch works)")
        passed = True
        # Give the cascade a moment to run (observe Deepgram/OpenAI/ElevenLabs in the worker log).
        await asyncio.sleep(8)
    except asyncio.TimeoutError:
        print(f"[validator] FAIL: the bot did NOT join within {DISPATCH_TIMEOUT_S:.0f}s")
    finally:
        sine_task.cancel()
        await room.disconnect()
    return passed


def main() -> None:
    ok = asyncio.run(run())
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
