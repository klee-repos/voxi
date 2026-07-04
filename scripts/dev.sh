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
    docker rm -f voxi-coturn >/dev/null 2>&1 && echo "✓ stopped coturn TURN relay" || true
  fi
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

# ---- coturn TURN relay (B1: voice CANNOT traverse a UDP-blocked device network without a relay; the
# device's ICE gathers TCP-only candidates that aiortc can't pair with, so a TURN relay is mandatory for
# voice off a permissive LAN). LAN-local coturn on the dev machine — both peers reach it outbound, so the
# relayed media stays on-LAN (low latency). Static dev creds voxi/voxi; prod uses a real TURN provider.
TURN_URLS="turn:$LAN_IP:3478?transport=tcp,turn:$LAN_IP:3478?transport=udp"
write_turn_env() {  # <file> <prefix>  — idempotently write the managed TURN block (prefix "" = server, "EXPO_PUBLIC_" = client)
  local file="$1" prefix="$2" tmp; tmp="$(mktemp)"
  {
    sed '/^# voxi-dev-turn-managed-start$/,/^# voxi-dev-turn-managed-end$/d' "$file" 2>/dev/null
    printf '\n# voxi-dev-turn-managed-start (scripts/dev.sh — coturn on the dev LAN IP; B1 fix)\n%sTURN_URL=%s\n%sTURN_USER=voxi\n%sTURN_PASS=voxi\n# voxi-dev-turn-managed-end\n' "$prefix" "$TURN_URLS" "$prefix" "$prefix"
  } > "$tmp" && mv "$tmp" "$file"
}
if command -v docker >/dev/null 2>&1; then
  echo "── coturn TURN relay (LAN-local; dev creds voxi:voxi) ──"
  docker rm -f voxi-coturn >/dev/null 2>&1
  if docker run -d --name voxi-coturn --restart unless-stopped \
      -p 3478:3478/udp -p 3478:3478/tcp -p 5349:5349/tcp -p 49160-49192:49160-49192/udp \
      coturn/coturn:latest \
      -n --listening-ip=0.0.0.0 --external-ip="$LAN_IP" --realm=voxi.dev \
      --user=voxi:voxi --lt-cred-mech --no-cli --no-tls --no-dtls \
      --min-port=49160 --max-port=49192 --fingerprint --log-file=stdout >/dev/null 2>&1; then
    echo "   ✓ coturn up → $TURN_URLS"
  else
    echo "   ⚠ coturn didn't start (docker pull ok?) — voice will fail on UDP-blocked networks (B1)"
  fi
  # Keep the server + client TURN env in sync with THIS LAN IP (idempotent managed block).
  write_turn_env "$REPO/.env.local" ""
  write_turn_env "$REPO/app/.env.local" "EXPO_PUBLIC_"
  echo "   ✓ TURN env written → .env.local (server TURN_*) + app/.env.local (client EXPO_PUBLIC_TURN_*)"
  echo
fi

# ---- clean slate ----
tmux kill-session -t "$SESSION" 2>/dev/null || true
free_ports
sleep 1

# ---- per-pane commands (each cd's to the right place + sets the env that service needs) ----
BFF_CMD="cd '$REPO' && PATH=\"$BREW_BIN:\$PATH\" $OTEL_ENV VOICE_SERVER_BASE_URL=http://$LAN_IP:7071 bun services/voxi-api/src/server.ts"
WORKER_CMD="cd '$REPO' && PATH=\"$BREW_BIN:\$PATH\" $OTEL_ENV PODCAST_PUBLIC_BASE=http://$LAN_IP:8788 GCS_AUDIO_BUCKET=voxi-podcast-audio-eighth-duality-354701 GCS_STATE_BUCKET=voxi-podcast-state-eighth-duality-354701 bun services/voxi-podcast-worker/src/server.ts"
VOICE_CMD="cd '$REPO' && set -a; source .env.local 2>/dev/null; set +a; $OTEL_ENV BFF_BASE_URL=http://$LAN_IP:8787 '$VENV_PY' services/voice-bot/voice_server.py --port 7071"
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
