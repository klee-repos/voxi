#!/usr/bin/env bash
# C3 SELFCALL — the >60s self-call check (vercel/workflow #1483; PLAN.md §4.4).
#
# graphile-worker advances a run by HTTP-calling the app's OWN /.well-known/workflow/v1/flow, which sits behind
# a ~60s route ceiling. Outcome is BINARY and BOTH are valid PASS values:
#   "completes"  -> the Cloud Run topology (timeout/ingress config) let a >60s self-call finish; long steps allowed.
#   "impossible" -> the route ceiling killed it; checkpoint-everything becomes MANDATORY and is recorded as a constraint.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

log "C3 >60s self-call (vercel/workflow #1483)"
require_eve_pinned

# Preconditions to verify on the live topology (record findings in out/C3.json):
#   - ingress forwards BOTH /eve/* AND /.well-known/workflow/* (§4.4)
#   - the service can reach its OWN base URL (no private-only ingress / split-horizon blocking the self-call)
#   - Cloud Run request timeout is set deliberately (it caps the self-call; default 300s, route ceiling ~60s)
#
# Procedure:
#   1. Drive a turn whose single step deliberately sleeps >60s (a probe step, NOT a real product step).
#   2. Watch the self-call to /.well-known/workflow/v1/flow and the run's advancement.
#   3. Record outcome=completes | impossible.
#
# Whichever it is, write the consequence into the eve turn-design constraints: if "impossible", every product
# turn MUST checkpoint frequently and genuinely-long work (podcast render) MUST offload to Cloud Tasks (§6.2/D7).

operator_required \
  "Run the >60s self-call probe on the live Cloud Run topology:" \
  "  - confirm ingress forwards /eve/* AND /.well-known/workflow/* and the service reaches its own base URL" \
  "  - drive a deliberate >60s probe step; observe the self-call to /.well-known/workflow/v1/flow" \
  "  - record C3 mode: 'completes' (long steps OK) or 'impossible' (checkpoint-everything MANDATORY)"

# record C3 pass C3_mode=completes     # or:  record C3 pass C3_mode=impossible
