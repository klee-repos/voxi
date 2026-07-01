# syntax=docker/dockerfile:1.7
#
# voice-bot — the realtime SmallWebRTC media plane (PLAN §6.3). A FastAPI/uvicorn signalling server that runs
# the STT→LLM→TTS cascade over real WebRTC media. It is the MEDIA plane, NOT an auth surface: the BFF mints a
# per-session connect URL (after a voiceMin entitlement check) and the voice-bot calls agent tools THROUGH the
# BFF via a per-session scoped token. Runtime: Python 3.12 (Pipecat/aiortc + the deepgram/elevenlabs/google
# vendor SDKs are the `live` optional extras).
#
# BUILD CONTEXT = repo root:
#   docker build -f infra/docker/voice-bot/Dockerfile -t voice-bot .

FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

# aiortc / onnxruntime (silero VAD) need a few native libs (libsndfile, libopus, libvpx, ffmpeg for media).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg libsndfile1 libopus0 libvpx-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install the voice-bot package with its LIVE extras (Pipecat cascade + vendor SDKs + uvicorn/fastapi).
# Copy only the package metadata first for layer caching, then the source.
COPY services/voice-bot/pyproject.toml services/voice-bot/README.md ./services/voice-bot/
COPY services/voice-bot/voxi_voice ./services/voice-bot/voxi_voice
COPY services/voice-bot/voice_server.py ./services/voice-bot/voice_server.py
RUN pip install "./services/voice-bot[live]"

COPY infra/docker/voice-bot/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV PORT=7071
EXPOSE 7071

# A non-root runtime user (the media plane runs untrusted RTC input; drop privileges).
RUN useradd --create-home --uid 10001 voxi
USER voxi

WORKDIR /app/services/voice-bot
ENTRYPOINT ["/app/entrypoint.sh"]
