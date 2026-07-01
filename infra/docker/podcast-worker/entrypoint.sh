#!/usr/bin/env sh
# voxi-podcast-worker entrypoint (PLAN §6.2 / D7 — async podcast render).
#
# A Cloud Tasks target (HTTP-pushed by the BFF after an atomic, idempotent entitlement gate). It validates the
# single-use generation token, runs the storyteller output through the claim-structured honesty + defamation
# validators, does ONE multi-speaker TTS call (timbre consistency, PLAN §6.2 D5), assembles with ffmpeg
# (loudnorm, ducked bed, crossfades), splits the finished audio locally into HLS chunks + playlist.m3u8, and
# writes them to GCS keyed by (catalog_item_id, version) with an atomic playlist swap. ffmpeg MUST be on PATH
# (installed in the image) — justbash cannot run it, which is exactly why this is a separate worker (D7).
set -eu

: "${PORT:=8080}"
export PORT

echo "podcast-worker starting: port=${PORT} ffmpeg=$(command -v ffmpeg || echo MISSING)"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg not on PATH — the worker cannot assemble HLS (PLAN §6.2/D7)." >&2
  exit 1
fi

# The worker's HTTP handler (receives the Cloud Task push). services/voxi-podcast-worker provides it once
# scaffolded; this wrapper boots it and is the documented seam until that entry lands.
if [ -f /app/services/voxi-podcast-worker/src/server.ts ]; then
  exec bun run /app/services/voxi-podcast-worker/src/server.ts
elif [ -f /app/services/voxi-podcast-worker/dist/server.js ]; then
  exec node /app/services/voxi-podcast-worker/dist/server.js
else
  echo "ERROR: no worker entry found (services/voxi-podcast-worker/src/server.ts). This is the podcast-worker seam." >&2
  exit 1
fi
