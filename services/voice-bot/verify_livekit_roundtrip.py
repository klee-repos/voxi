"""
Full round-trip LiveKit voice-agent validation — the "send and end", with NO device.

verify_livekit_agent.py proves DISPATCH (the bot joins). This goes further: it proves the whole cascade
actually PROCESSES audio end-to-end. A headless caller:
  1. synthesizes a real spoken question (ElevenLabs TTS → ffmpeg → 48kHz mono PCM),
  2. joins the room + publishes it as the mic track (real speech — a sine wave won't transcribe),
  3. streams trailing silence so the bot's VAD detects end-of-turn (→ triggers the LLM turn),
  4. subscribes to the bot's audio track and COUNTS the audio it publishes back.

Verdict (exit 0/1): the bot must (a) join AND (b) publish >~0.5s of audio back = STT→LLM→TTS ran. Any
transcription events seen are printed as a bonus. This isolates SERVER-cascade health from client/device issues.

Prereqs (scripts/dev.sh): LiveKit dev server :7880 + livekit_bot worker + ELEVENLABS/DEEPGRAM/OPENAI keys + ffmpeg.
Run:
    set -a; source .env.local; set +a
    LIVEKIT_API_SECRET=voxi-livekit-dev-secret-32chars-ok \
      services/voice-bot/.venv/bin/python services/voice-bot/verify_livekit_roundtrip.py
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request

from livekit import rtc
from livekit.api import AccessToken, VideoGrants

URL = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
KEY = os.getenv("LIVEKIT_API_KEY", "devkey")
SECRET = os.getenv("LIVEKIT_API_SECRET", "secret")
ROOM = os.getenv("LIVEKIT_VALIDATE_ROOM", f"voxi-rt-{int(time.time())}")
EL_KEY = os.getenv("ELEVENLABS_API_KEY", "")
CALLER_VOICE = os.getenv("VALIDATE_CALLER_VOICE_ID", "CwhRBWXzGAHq8TQ4Fs17")  # a non-Voxi voice for the "user"
UTTERANCE = "Hello there. What is this object, and what is it made of?"
SR = 48000
FRAME_MS = 20
PCM_CACHE = "/tmp/voxi-validate-utterance-48k.pcm"
# Bot must publish at least this many bytes back (s16le mono 48k → 96000 bytes/sec). ~0.5s of real TTS audio.
MIN_BOT_AUDIO_BYTES = 48000


def synth_caller_pcm() -> bytes:
    """ElevenLabs TTS → MP3 → ffmpeg → raw s16le 48k mono PCM. Cached so re-runs are instant."""
    if os.path.exists(PCM_CACHE) and os.path.getsize(PCM_CACHE) > SR:  # ≥ ~0.5s cached
        return open(PCM_CACHE, "rb").read()
    if not EL_KEY:
        print("[caller] FAIL: ELEVENLABS_API_KEY not set — cannot synthesize the caller's speech", flush=True)
        sys.exit(2)
    print(f"[caller] synthesizing utterance via ElevenLabs ({CALLER_VOICE})…", flush=True)
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{CALLER_VOICE}?output_format=mp3_44100_128",
        data=json.dumps({"text": UTTERANCE, "model_id": "eleven_turbo_v2_5"}).encode(),
        headers={"xi-api-key": EL_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        mp3 = resp.read()
    # decode MP3 → raw PCM s16le 48k mono
    proc = subprocess.run(
        ["/opt/homebrew/bin/ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-f", "s16le", "-ar", str(SR), "-ac", "1", "pipe:1"],
        input=mp3, stdout=subprocess.PIPE, check=True,
    )
    pcm = proc.stdout
    open(PCM_CACHE, "wb").write(pcm)
    print(f"[caller] synthesized {len(pcm)} PCM bytes ({len(pcm)/2/SR:.1f}s)", flush=True)
    return pcm


async def run() -> bool:
    pcm = synth_caller_pcm()

    token = (
        AccessToken(KEY, SECRET)
        .with_identity("validator")
        .with_metadata(f'{{"connectId":"validate","threadId":"{ROOM}","userId":"validator"}}')
        .with_grants(VideoGrants(room_join=True, room=ROOM, can_publish=True, can_subscribe=True,
                                 can_publish_data=True, agent=True))
        .to_jwt()
    )

    room = rtc.Room()
    bot_joined = asyncio.Event()
    bot_audio_bytes = 0
    transcripts: list[str] = []

    @room.on("participant_connected")
    def _on_pc(p: rtc.RemoteParticipant) -> None:
        if p.identity != "validator":
            print(f"[validator] bot joined: {p.identity!r}", flush=True)
            bot_joined.set()

    @room.on("track_subscribed")
    def _on_track(track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO and p.identity != "validator":
            print(f"[validator] subscribed to bot audio track (sid={pub.sid}) — reading frames…", flush=True)
            asyncio.create_task(_drain_bot_audio(track))

    async def _drain_bot_audio(track: rtc.Track) -> None:
        nonlocal bot_audio_bytes
        stream = rtc.AudioStream(track)
        async for ev in stream:
            # ev.frame.data is bytes-like; count non-trivial audio (the bot's TTS reply)
            bot_audio_bytes += len(bytes(ev.frame.data))

    # Best-effort transcription capture (event name varies by rtc version).
    def _on_transcription(seg) -> None:  # noqa: ANN001
        try:
            for s in seg.segments if hasattr(seg, "segments") else []:
                if s.text:
                    transcripts.append(s.text)
        except Exception:  # noqa: BLE001
            pass
    try:
        room.on("transcription_received", _on_transcription)
    except Exception:  # noqa: BLE001
        pass

    await room.connect(URL, token)
    print(f"[validator] connected to room {ROOM!r}", flush=True)

    # Publish the caller mic track.
    source = rtc.AudioSource(SR, 1)
    track = rtc.LocalAudioTrack.create_audio_track("validator-mic", source)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions())

    # Wait for the bot to be dispatched + join before speaking (so its AgentSession is subscribed).
    try:
        await asyncio.wait_for(bot_joined.wait(), timeout=15)
    except asyncio.TimeoutError:
        print("[validator] FAIL: the bot never joined (no agent dispatch)", flush=True)
        await room.disconnect()
        return False
    await asyncio.sleep(1.0)  # let the bot's track subscription settle

    async def stream_pcm(data: bytes) -> None:
        samples = int(SR * FRAME_MS / 1000)
        step = samples * 2  # s16le mono = 2 bytes/sample
        for off in range(0, len(data), step):
            chunk = data[off:off + step]
            if len(chunk) < step:
                chunk = chunk + b"\x00" * (step - len(chunk))
            await source.capture_frame(rtc.AudioFrame(chunk, SR, 1, samples))
            await asyncio.sleep(FRAME_MS / 1000)

    print(f"[validator] speaking: {UTTERANCE!r}", flush=True)
    await stream_pcm(pcm)
    print("[validator] finished speaking; streaming ~4s silence so VAD detects end-of-turn…", flush=True)
    await stream_pcm(b"\x00" * (SR * 2 * 4))  # 4s silence → end-of-utterance → LLM turn

    # Give the cascade time to STT → LLM → TTS → publish audio back.
    deadline = 18
    for _ in range(deadline):
        if bot_audio_bytes >= MIN_BOT_AUDIO_BYTES:
            break
        await asyncio.sleep(1)

    await room.disconnect()
    secs = bot_audio_bytes / 2 / SR
    print(f"[validator] bot audio received: {bot_audio_bytes} bytes (~{secs:.1f}s)", flush=True)
    if transcripts:
        print(f"[validator] transcripts seen: {transcripts}", flush=True)
    ok = bot_audio_bytes >= MIN_BOT_AUDIO_BYTES
    print(
        f"[validator] {'PASS' if ok else 'FAIL'}: the bot {'RESPONDED with audio (STT→LLM→TTS ran)' if ok else 'did NOT respond with audio — cascade did not complete'}",
        flush=True,
    )
    return ok


def main() -> None:
    sys.exit(0 if asyncio.run(run()) else 1)


if __name__ == "__main__":
    main()
