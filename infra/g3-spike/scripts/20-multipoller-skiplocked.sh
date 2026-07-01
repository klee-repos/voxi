#!/usr/bin/env bash
# C2 SKIPLOCKED — multi-poller correctness (TEST-PLAN infra-02; PLAN.md §4.4).
#
# Confirm @workflow/world-postgres supports MULTIPLE concurrent pollers via SELECT ... FOR UPDATE SKIP LOCKED.
# Run >=2 pollers on one world under load; assert NO workflow step is double-processed. If world-postgres turns
# out single-poller-only, record the failover + throughput ceiling instead (the §4.4 fallback branch).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

POLLERS="${POLLERS:-2}"
TARGET_TPS="${TARGET_TPS:-5}"     # pinned turns/sec target (§22.6: pinned before §20.9); override per load test

log "C2 multi-poller SKIP-LOCKED — ${POLLERS} pollers @ ${TARGET_TPS} turns/sec"
require_eve_pinned
require_world

# (1) Boot POLLERS>=2 graphile-worker pollers on the same world-postgres database.
# (2) Run the load generator at TARGET_TPS for a fixed window.
#       bun "${G3_DIR}/scripts/load-gen.ts" --tps "$TARGET_TPS" --seconds 60
# (3) Probe the world tables for any step claimed/executed by more than one poller (double-processing).
#       psql "$WORLD_DATABASE_URL" -f "${G3_DIR}/sql/skip-locked-probe.sql"
#     Expected: zero rows in the "double_processed" result set; every step lease is exclusive.

operator_required \
  "Run the multi-poller load test (needs a live world + >=2 pollers):" \
  "  - start ${POLLERS} pollers (WORKFLOW_ROLE=poller eve worker), all on \$WORLD_DATABASE_URL" \
  "  - bun ${G3_DIR}/scripts/load-gen.ts --tps ${TARGET_TPS} --seconds 60" \
  "  - psql \$WORLD_DATABASE_URL -f ${G3_DIR}/sql/skip-locked-probe.sql   (expect 0 double-processed rows)" \
  "  - if multi-poller is unsupported: record single-poller failover + throughput ceiling instead"

# record C2 pass throughput="${TARGET_TPS}tps"   # <- only after a real zero-double-processed result
