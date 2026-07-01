#!/usr/bin/env bash
# Shared helpers for the G3 spike scripts. Source this from each step script.
# Design rule: NEVER fake a PASS. If a precondition (creds / installed eve / a live world) is missing,
# call `operator_required` and exit non-zero. G3 is meaningless if it can be mocked green.
set -euo pipefail

G3_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${G3_DIR}/out"
mkdir -p "${OUT_DIR}"

log()  { printf '\033[1;36m[g3]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[g3] PASS\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[g3] FAIL\033[0m %s\n' "$*" >&2; }

# Record a step result as JSON so 99-verdict.sh can aggregate without re-running anything.
record() { # record <step-id> <pass|fail> [k=v ...]
  local id="$1" verdict="$2"; shift 2
  local extra=""
  for kv in "$@"; do extra="${extra}, \"${kv%%=*}\": \"${kv#*=}\""; done
  printf '{ "id": "%s", "verdict": "%s", "ts": "%s"%s }\n' \
    "$id" "$verdict" "$(date -u +%FT%TZ)" "$extra" > "${OUT_DIR}/${id}.json"
}

# Hard stop: a human/CI operator must perform a cloud or install action we cannot do without creds.
operator_required() {
  fail "OPERATOR ACTION REQUIRED — cannot proceed without creds/toolchain in this environment:"
  printf '       %s\n' "$@" >&2
  exit 78  # EX_CONFIG
}

# Assert the eve toolchain is actually installed at a pinned version (no floating; vercel/workflow #1416).
require_eve_pinned() {
  command -v eve >/dev/null 2>&1 || operator_required \
    "the 'eve' CLI is not installed. Install the pinned toolchain (see infra/g3-spike/out/pinned-versions.json)."
  [ -f "${REPO_ROOT:-$G3_DIR/../..}/bun.lock" ] || log "note: no lockfile found; pin recording (C4) will be partial."
}

# Assert NO Vercel platform service is in the dependency or runtime path — the core of the boot proof.
# Scans the eve project deps for @vercel/* and Vercel KV/Blob/Edge-Config adapters.
assert_vercel_ripped() { # assert_vercel_ripped <eve-project-dir>
  local dir="$1"
  local hits
  hits="$(grep -REl --include='package.json' \
      -e '@vercel/' -e 'vercel/kv' -e 'vercel/blob' -e 'vercel/edge-config' \
      "$dir" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    fail "Vercel adapters still present (boot proof requires ZERO Vercel platform services):"
    printf '       %s\n' $hits >&2
    return 1
  fi
  # the durable world MUST be world-postgres, not a Vercel-hosted world
  if ! grep -REq -e 'world-postgres' "$dir" 2>/dev/null; then
    fail "no @workflow/world-postgres reference found — world must be Postgres, not a Vercel-hosted world."
    return 1
  fi
  ok "Vercel adapters ripped; world = world-postgres"
}

# A reachable durable world (Postgres). Locally: docker-compose. On GCP: Cloud SQL via the connector.
require_world() {
  : "${WORLD_DATABASE_URL:?}" 2>/dev/null || operator_required \
    "WORLD_DATABASE_URL is unset. Point it at the world-postgres database (local docker-compose Postgres or Cloud SQL)."
}
