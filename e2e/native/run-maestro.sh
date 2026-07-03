#!/usr/bin/env bash
# Native iOS Maestro tier runner (local simulator). Boots the deterministic test-BFF, runs the SIM-RUNNABLE flows
# against a booted simulator that already has the maestro build of com.kvnlee.voxi installed, then tears the BFF
# down. Hardware-only flows (StoreKit sub-03, mic/WebRTC conv-*, Universal Link auth-05, OS-permission cam-01/02)
# are deliberately NOT in this set — they need a real device / Maestro Cloud (see docs/IOS-TESTING.md).
#
# Prereqs: a JDK (JAVA_HOME), the maestro CLI (~/.maestro/bin on PATH), and a maestro/E2E Release build installed
# on a booted sim: from app/, with the maestro env, `npx expo run:ios --configuration Release --device <sim>`.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
export PATH="$HOME/.maestro/bin:$PATH"

# Sim-runnable flows (each proven green against the maestro Release build + the deterministic test-BFF).
#   auth-01    — FakeAuth auto-signin lands the authed session on the camera
#   cam-03     — shutter → bundled fixture → POST /threads → test-BFF → reveal.card (the full native pipeline)
#   seed-steer — deep-link band steer (voxi://e2e?seed=pill → X-Voxi-Test-Seed header → safety refusal)
#   drawer-nav — open the slide-out drawer → Settings (the repair pattern for the drawer-occluded flows)
FLOWS=(auth-01 cam-03 seed-steer drawer-nav)

echo "[e2e:ios] booting deterministic test-BFF on :8787"
bun "$ROOT/e2e/native/test-bff.ts" >/tmp/voxi-test-bff.log 2>&1 &
BFF_PID=$!
trap 'kill "$BFF_PID" 2>/dev/null || true' EXIT
sleep 1

fails=0
for f in "${FLOWS[@]}"; do
  echo "[e2e:ios] --- maestro test $f ---"
  if ! maestro test "$ROOT/e2e/flows/$f.yaml"; then
    fails=$((fails + 1))
    echo "[e2e:ios] FAILED: $f"
  fi
done
echo "[e2e:ios] done — ${fails} failing flow(s) of ${#FLOWS[@]}"
exit "$fails"
