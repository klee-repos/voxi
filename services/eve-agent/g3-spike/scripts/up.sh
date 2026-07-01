#!/usr/bin/env bash
# Bring up a throwaway LOCAL Postgres + migrate the @workflow/world-postgres durable world (the Cloud SQL
# analogue) so boot.ts can run the off-Vercel existence proof on a laptop / CI — NO GCP, NO Vercel.
#
# This is the exact procedure used to record RESULT.md. It uses a non-standard port (55432) and a user-owned
# data dir under /tmp with trust auth, so it never touches a system Postgres and needs no root.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPIKE="$(cd "$HERE/.." && pwd)"

PGDATA="${PGDATA:-/tmp/voxi-g3-pg}"
PGPORT="${PGPORT:-55432}"
PGSOCK="${PGSOCK:-/tmp}"
PGUSER="${PGUSER:-voxi}"
DB="${DB:-voxi_world}"
export DATABASE_URL="postgres://${PGUSER}@127.0.0.1:${PGPORT}/${DB}"

PGBIN="${PGBIN:-$(dirname "$(command -v postgres || echo /opt/homebrew/bin/postgres)")}"
echo "using postgres bin: $PGBIN"

if [ ! -d "$PGDATA/base" ]; then
  echo "initdb -> $PGDATA"
  "$PGBIN/initdb" -D "$PGDATA" -U "$PGUSER" --auth=trust >/dev/null
fi

if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  echo "starting postgres on :$PGPORT"
  "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -k $PGSOCK" -l /tmp/voxi-g3-pg.log start
  sleep 2
fi

"$PGBIN/psql" -h "$PGSOCK" -p "$PGPORT" -U "$PGUSER" -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='${DB}'" | grep -q 1 \
  || "$PGBIN/psql" -h "$PGSOCK" -p "$PGPORT" -U "$PGUSER" -d postgres -c "CREATE DATABASE ${DB};"

echo "migrating the @workflow/world-postgres durable world..."
cd "$SPIKE"
DATABASE_URL="$DATABASE_URL" WORKFLOW_POSTGRES_URL="$DATABASE_URL" ./node_modules/.bin/workflow-postgres-setup 2>&1 | grep -vE "dotenv|tip:" || true

echo
echo "world up. run the boot proof with:"
echo "  DATABASE_URL=$DATABASE_URL bun ../g3-spike/boot.ts"
echo "  (from repo root: DATABASE_URL=$DATABASE_URL bun services/eve-agent/g3-spike/boot.ts)"
