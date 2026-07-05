#!/usr/bin/env bash
#
# Voxi local dev — start all backend services for on-device testing in a tmux 2×2 grid.
#
#   ./scripts/dev.sh          start EVERYTHING (services + observability stack) and attach
#   ./scripts/dev.sh down     stop EVERYTHING in one go (tmux session + ports + observability containers)
#   LAN_IP=10.0.0.5 ./scripts/dev.sh   override the auto-detected LAN IP
#
# Panes:  BFF :8787 · podcast-worker :8788 · voice :7071 · Metro :8081
# Your phone (same Wi-Fi) hits http://<LAN_IP>:8787 for the API and :8081 for the JS bundle.
# Logs:   structured NDJSON in every pane, and queryable in Grafana at http://localhost:3000.
#
# Detach without stopping: Ctrl-b then d   ·   Kill everything: ./scripts/dev.sh down
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="voxi"
PORTS=(8787 8788 7071 8081)

free_ports() {
  for port in "${PORTS[@]}"; do
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
  done
}

OBS_COMPOSE=(docker compose -f "$REPO/infra/observability/docker-compose.yml")

# ---- `down`: tear the WHOLE stack down in one go (tmux services + ports + observability containers) ----
if [[ "${1:-}" == "down" || "${1:-}" == "stop" ]]; then
  tmux kill-session -t "$SESSION" 2>/dev/null && echo "✓ stopped tmux session '$SESSION'" || echo "no '$SESSION' session running"
  free_ports
  echo "✓ freed ports ${PORTS[*]}"
  if command -v docker >/dev/null 2>&1; then
    "${OBS_COMPOSE[@]}" down >/dev/null 2>&1 && echo "✓ stopped observability stack" || echo "  (observability stack was not running)"
    docker rm -f voxi-livekit >/dev/null 2>&1 && echo "✓ stopped LiveKit dev server" || true
  fi
  pkill -f "livekit_bot.py" 2>/dev/null && echo "✓ stopped the voice bot" || true
  echo "✓ all down."
  exit 0
fi

# ---- discovery ----
LAN_IP="${LAN_IP:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)}"
BREW_BIN="/opt/homebrew/bin"   # ffmpeg (podcast mux) + tmux live here
# Expo SDK 57's CLI needs Node ≥20.19.4 — pick the newest nvm v22+/v20.19+ install.
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v2[2-9]*/bin 2>/dev/null | sort -V | tail -1)"
[ -z "$NODE_BIN" ] && NODE_BIN="$(command -v node >/dev/null && dirname "$(command -v node)")"
VENV_PY="$REPO/services/voice-bot/.venv/bin/python"

# ---- preflight ----
command -v tmux >/dev/null || { echo "✗ tmux not found. Install: brew install tmux"; exit 1; }
[ -f "$REPO/.env.local" ] || echo "⚠  no $REPO/.env.local — services will lack vendor keys (Clerk/GCP/ElevenLabs/Deepgram)"
[ -x "$NODE_BIN/node" ] || echo "⚠  no Node ≥20.19.4 found ($NODE_BIN) — Metro (Expo SDK 57) will fail"
[ -x "$VENV_PY" ] || echo "⚠  voice-bot venv missing ($VENV_PY) — the voice pane will fail (run: python3 -m venv services/voice-bot/.venv && pip install …)"
[ -x "$BREW_BIN/ffmpeg" ] || echo "⚠  ffmpeg not at $BREW_BIN — podcast render will fail (brew install ffmpeg)"

echo "── Voxi dev services ──"
echo "   LAN IP : $LAN_IP   (phone → http://$LAN_IP:8787 API, http://$LAN_IP:8081 bundle)"
echo "   Node   : $NODE_BIN"
echo

# ---- observability stack (Grafana Alloy + Loki + Tempo + Grafana) — brought up with everything else ----
# Inline OTEL_ENV wins over any .env.local value, so the panes ship to the LOCAL collector during dev.
OTEL_ENV=""
if command -v docker >/dev/null 2>&1; then
  echo "── observability stack ──"
  if "${OBS_COMPOSE[@]}" up -d >/dev/null 2>&1; then
    OTEL_ENV="OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318"
    echo "   ✓ Grafana → http://localhost:3000   ·   services ship OTLP → localhost:4318"
  else
    echo "   ⚠ stack didn't start (is Docker running?) — services still log to stdout"
  fi
  echo
else
  echo "⚠  Docker not found — observability stack skipped; services still log to stdout"
  echo
fi

# ---- LiveKit dev server (the voice media plane — replaces coturn + the pipecat SmallWebRTC voice_server).
# LiveKit owns the WebRTC media + ICE/TURN; the voice-bot is a livekit-agents Worker (livekit_bot.py). Docker dev
# server with a config that binds 0.0.0.0 (so the device reaches it on the LAN IP) + a ≥32-char dev secret.
LIVEKIT_URL="ws://$LAN_IP:7880"
LIVEKIT_API_KEY="devkey"
LIVEKIT_API_SECRET="voxi-livekit-dev-secret-32chars-ok"  # ≥32 chars (LiveKit enforces); dev-only, not for prod
write_livekit_env() {  # <file> <prefix> — idempotently write the managed LIVEKIT block
  local file="$1" prefix="$2" tmp; tmp="$(mktemp)"
  {
    sed '/^# voxi-dev-livekit-managed-start$/,/^# voxi-dev-livekit-managed-end$/d' "$file" 2>/dev/null
    printf '\n# voxi-dev-livekit-managed-start (scripts/dev.sh — LiveKit dev server on the LAN IP)\n%sLIVEKIT_URL=%s\n%sLIVEKIT_API_KEY=%s\n%sLIVEKIT_API_SECRET=%s\n# voxi-dev-livekit-managed-end\n' "$prefix" "$LIVEKIT_URL" "$prefix" "$LIVEKIT_API_KEY" "$prefix" "$LIVEKIT_API_SECRET"
  } > "$tmp" && mv "$tmp" "$file"
}
echo "── LiveKit dev server (Docker; dev creds devkey) ──"
mkdir -p "$REPO/.voxi-data"
cat > "$REPO/.voxi-data/livekit-dev.yaml" <<YAML
port: 7880
bind_addresses:
  - "0.0.0.0"
rtc:
  tcp_port: 7881
  port_range_start: 7882
  port_range_end: 7892
  use_external_ip: true
keys:
  $LIVEKIT_API_KEY: $LIVEKIT_API_SECRET
logging:
  level: info
YAML
docker rm -f voxi-livekit >/dev/null 2>&1
if docker run -d --name voxi-livekit --restart unless-stopped \
    -p 7880:7880 -p 7881:7881 -p 7882-7892:7882-7892/udp \
    -v "$REPO/.voxi-data/livekit-dev.yaml:/config.yaml" \
    livekit/livekit-server --config /config.yaml --node-ip=127.0.0.1 >/dev/null 2>&1; then
  sleep 2
  echo "   ✓ LiveKit dev server up → $LIVEKIT_URL"
else
  echo "   ⚠ LiveKit dev server didn't start (Docker running?) — voice will 503 at the BFF mint"
fi
# The BFF mints LiveKit tokens with these (server-side env); the client gets url+token from the BFF response.
write_livekit_env "$REPO/.env.local" ""
echo "   ✓ LIVEKIT_URL/API_KEY/API_SECRET written → .env.local (BFF mints tokens with these)"
# stop the old TURN relay (no longer used — LiveKit owns ICE/TURN).
pkill -f "turnserver.*voxi.dev" 2>/dev/null || true
docker rm -f voxi-coturn >/dev/null 2>&1 || true
echo

# ---- clean slate ----
tmux kill-session -t "$SESSION" 2>/dev/null || true
free_ports
sleep 1

# ---- per-pane commands (each cd's to the right place + sets the env that service needs) ----
BFF_CMD="cd '$REPO' && set -a; source .env.local 2>/dev/null; set +a; PATH=\"$BREW_BIN:\$PATH\" $OTEL_ENV bun services/voxi-api/src/server.ts"
WORKER_CMD="cd '$REPO' && PATH=\"$BREW_BIN:\$PATH\" $OTEL_ENV PODCAST_PUBLIC_BASE=http://$LAN_IP:8788 GCS_AUDIO_BUCKET=voxi-podcast-audio-eighth-duality-354701 GCS_STATE_BUCKET=voxi-podcast-state-eighth-duality-354701 bun services/voxi-podcast-worker/src/server.ts"
VOICE_CMD="cd '$REPO' && set -a; source .env.local 2>/dev/null; set +a; $OTEL_ENV BFF_BASE_URL=http://$LAN_IP:8787 LIVEKIT_URL=ws://$LAN_IP:7880 LIVEKIT_AGENT_PORT=8089 '$VENV_PY' services/voice-bot/livekit_bot.py start"
METRO_CMD="cd '$REPO/app' && PATH=\"$NODE_BIN:$BREW_BIN:\$PATH\" REACT_NATIVE_PACKAGER_HOSTNAME=$LAN_IP EXPO_NO_TELEMETRY=1 npx expo start --host lan --port 8081"

# ---- build the 2×2 grid ----
tmux new-session -d -s "$SESSION" -n services
tmux split-window -h -t "$SESSION:services"          # → pane 1 (right)
tmux split-window -v -t "$SESSION:services.1"         # → pane 2 (bottom-right)
tmux split-window -v -t "$SESSION:services.0"         # → pane 3 (bottom-left)
tmux select-layout -t "$SESSION:services" tiled

# label + launch each pane
tmux set-option -t "$SESSION" -g mouse on 2>/dev/null || true
tmux set-option -t "$SESSION" pane-border-status top 2>/dev/null || true
tmux set-option -t "$SESSION" pane-border-format " #{pane_title} " 2>/dev/null || true

launch() { # pane title command
  tmux select-pane -t "$SESSION:services.$1" -T "$2" 2>/dev/null || true
  tmux send-keys -t "$SESSION:services.$1" "$3" C-m
}
launch 0 "BFF :8787"            "$BFF_CMD"
launch 3 "podcast-worker :8788" "$WORKER_CMD"
launch 1 "voice :7071"          "$VOICE_CMD"
launch 2 "Metro :8081"          "$METRO_CMD"

echo "✓ started. Detach: Ctrl-b d   ·   Stop all (services + observability): ./scripts/dev.sh down"
tmux attach -t "$SESSION"
