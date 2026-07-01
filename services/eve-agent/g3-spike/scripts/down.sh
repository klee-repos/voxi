#!/usr/bin/env bash
# Tear down the throwaway local Postgres world brought up by up.sh. Safe to run repeatedly.
set -euo pipefail
PGDATA="${PGDATA:-/tmp/voxi-g3-pg}"
PGBIN="${PGBIN:-$(dirname "$(command -v postgres || echo /opt/homebrew/bin/postgres)")}"
if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$PGDATA" stop -m fast || true
fi
rm -rf "$PGDATA" /tmp/voxi-g3-pg.log
echo "world torn down ($PGDATA removed)."
