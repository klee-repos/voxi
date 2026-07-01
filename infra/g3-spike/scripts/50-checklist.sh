#!/usr/bin/env bash
# S1/S2 checklist (PLAN.md §22.3) — recorded findings, not pass/fail blockers, but must be answered.
#   S1: do eve schedules/{dedup,promote} run under world-postgres? (insurance: also Cloud-Scheduler→BFF-cron drivable)
#   S2: does the eve custom AuthFn verify the Clerk JWT networkless (@clerk/backend verifyToken + JWKS) off-Vercel?
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

log "S1/S2 G3 checklist"

# S1 — static signal: are schedules wired to the world, and is the Cloud-Scheduler fallback spec'd?
EVE_PROJECT_DIR="${EVE_PROJECT_DIR:-${G3_DIR}/../../services/eve-agent}"
if grep -REq -e 'schedules/(dedup|promote)' "$EVE_PROJECT_DIR" 2>/dev/null; then
  log "S1: eve schedules present — confirm at runtime whether they fire under world-postgres."
else
  log "S1: eve schedules not yet authored here (services workflow owns them) — confirm at runtime."
fi
log "S1 insurance (required regardless): dedup/promote MUST also be Cloud-Scheduler→BFF-cron drivable (§22.3),"
log "    so the moat machinery does not inherit eve's scheduler risk."

# S2 — the AuthFn must boot and verify a Clerk JWT WITHOUT a network round-trip (networkless, §12).
log "S2: confirm channels/eve.ts AuthFn verifies a Clerk session JWT via @clerk/backend verifyToken + cached JWKS,"
log "    enforces per-user session-ownership ACL, and boots off-Vercel (no Vercel auth middleware)."

operator_required \
  "Record the runtime answers (needs a live boot):" \
  "  - S1: do schedules/dedup + schedules/promote actually fire under world-postgres? (yes/no -> out/S1.json)" \
  "  - S2: does a forged/expired Clerk JWT get rejected networkless, and a valid one accepted? (-> out/S2.json)"
