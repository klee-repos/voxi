#!/usr/bin/env sh
# voice-bot entrypoint (PLAN §6.3) — the realtime SmallWebRTC media plane.
#
# Boots the uvicorn signalling server (voice_server.py:app). The BFF points a client here (with a per-session
# scoped token) after a voiceMin entitlement check; this process is the media plane, the BFF stays the only
# auth surface. Fails LOUDLY if the server module is missing — never a fake-healthy no-op.
set -eu

: "${PORT:=7071}"
export PORT

echo "voice-bot starting: port=${PORT} python=$(python --version 2>&1)"
echo "  vendor creds present: deepgram=$( [ -n "${DEEPGRAM_API_KEY:-}" ] && echo yes || echo no ) elevenlabs=$( [ -n "${ELEVENLABS_API_KEY:-}" ] && echo yes || echo no )"

if [ ! -f /app/services/voice-bot/voice_server.py ]; then
  echo "ERROR: voice_server.py not found — the voice-bot media plane cannot start (PLAN §6.3)." >&2
  exit 1
fi

# uvicorn serves the FastAPI app (the /offer SmallWebRTC signalling handshake).
exec uvicorn voice_server:app --host 0.0.0.0 --port "${PORT}"
