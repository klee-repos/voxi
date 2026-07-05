"""
LiveKit Agents entrypoint for the Voxi voice bot.

Run (dev, against the local LiveKit dev server):
    LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
    BFF_BASE_URL=http://192.168.1.193:8787 \
    DEEPGRAM_API_KEY=… ELEVENLABS_API_KEY=… OPENAI_API_KEY=… \
    services/voice-bot/.venv/bin/python services/voice-bot/livekit_bot.py start

First run downloads the bundled Silero VAD model:
    services/voice-bot/livekit_bot.py download-files

The bot connects as a LiveKit Worker; when a caller joins a room with an agent-grant token (the BFF mints
it), LiveKit dispatches a job → entrypoint() → the cascade (Deepgram→OpenAI→ElevenLabs) runs in that room.
"""

from __future__ import annotations

from voxi_voice.livekit_agent import main

if __name__ == "__main__":
    main()
