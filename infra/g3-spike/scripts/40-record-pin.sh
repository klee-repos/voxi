#!/usr/bin/env bash
# C4 PIN — record the EXACT (eve, @workflow/*, world-postgres) triple actually under test, then prove the
# §4.5 CI resume-test is green on it (vercel/workflow #1416 cross-version transport break is the falsifier).
#
# The pin is READ FROM THE INSTALLED LOCKFILE — never hand-typed — so out/pinned-versions.json is the truth of
# what booted, and infra/ci's version-pin matrix smoke runs against this same triple.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REPO_ROOT="${REPO_ROOT:-$(cd "${G3_DIR}/../.." && pwd)}"
LOCK="${REPO_ROOT}/bun.lock"
OUT="${OUT_DIR}/pinned-versions.json"

log "C4 record pinned triple"

if [ ! -f "$LOCK" ]; then
  operator_required \
    "no bun.lock at ${LOCK}. Install the pinned eve toolchain first, then re-run so the pin is read from the lockfile." \
    "Do NOT hand-edit pinned-versions.json — the whole point is that it reflects what actually booted."
fi

# Extract resolved versions for the eve runtime + every @workflow/* package + world-postgres from the lockfile.
# (bun.lock is JSON-ish; this grep-based extractor is intentionally simple and is validated by infra/ci.)
extract() { # extract <pkg-name>
  grep -oE "\"$1@[^\"]+\"" "$LOCK" 2>/dev/null | head -1 | sed -E "s/.*@([^\"]+)\"/\1/" || true
}

EVE_VER="$(extract 'eve')"
WORLD_VER="$(extract '@workflow/world-postgres')"
# Collect every @workflow/* line so a cross-version break (#1416) is visible.
WORKFLOW_PKGS="$(grep -oE '"@workflow/[^"@]+@[^"]+"' "$LOCK" 2>/dev/null | sort -u | sed -E 's/"//g' || true)"

{
  echo '{'
  echo "  \"recordedAt\": \"$(date -u +%FT%TZ)\","
  echo "  \"eve\": \"${EVE_VER:-UNKNOWN}\","
  echo "  \"worldPostgres\": \"${WORLD_VER:-UNKNOWN}\","
  echo '  "workflowPackages": ['
  if [ -n "$WORKFLOW_PKGS" ]; then
    printf '    "%s"' "$(echo "$WORKFLOW_PKGS" | head -1)"
    echo "$WORKFLOW_PKGS" | tail -n +2 | while read -r p; do printf ',\n    "%s"' "$p"; done
    echo ''
  fi
  echo '  ],'
  echo "  \"source\": \"bun.lock\""
  echo '}'
} > "$OUT"

log "wrote $OUT"
cat "$OUT"

if [ "${EVE_VER:-UNKNOWN}" = "UNKNOWN" ] || [ "${WORLD_VER:-UNKNOWN}" = "UNKNOWN" ]; then
  fail "eve or world-postgres not found in lockfile — the pinned toolchain is not installed yet."
  record C4 fail reason=triple-not-installed
  exit 1
fi

log "now run the §4.5 resume-test against this triple via infra/ci:  bun run ci:pin-matrix"
# record C4 pass   # <- only after ci:pin-matrix is green on this exact triple
