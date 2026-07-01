/**
 * apply-migrations.ts — the REAL migration runner (PLAN §11, task #22).
 *
 * Runs the numbered `packages/db/migrations/NNNN_*.sql` files, in order, against `DATABASE_URL`, inside a
 * transaction per file, and records each applied file in `app.schema_migrations` so re-runs are no-ops
 * (idempotent). This is what `bun run db:migrate` invokes and what infra/deploy/deploy.sh runs at deploy time.
 *
 * Client: Bun's built-in `Bun.sql` (Postgres) — NO new npm dependency, so it cannot disturb the fragile
 * workspace node_modules. It runs under Bun locally and in the deploy image (the eve prod runtime is Node ≥24,
 * but this runner is a standalone `bun` invocation in the deploy step). It FAILS LOUDLY if `DATABASE_URL` is
 * absent or a migration errors — never a fake success (the repo's "seams fail loudly" rule).
 *
 * Usage:
 *   DATABASE_URL=postgres://user@host:5432/db  bun packages/db/apply-migrations.ts
 *   DATABASE_URL=... bun packages/db/apply-migrations.ts --dir packages/db/migrations
 */
import { SQL } from 'bun'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** A numbered migration file, sorted by its `NNNN` prefix. */
interface Migration {
  version: string // the leading numeric id, e.g. "0001"
  name: string // the full filename
  path: string
  sql: string
}

/** Parse `--dir <path>` from argv; default to this file's sibling `migrations/` dir. */
function migrationsDir(argv: string[]): string {
  const i = argv.indexOf('--dir')
  const raw = i >= 0 && argv[i + 1] ? argv[i + 1]! : join(HERE, 'migrations')
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
}

/** Load + sort the migration files (`NNNN_*.sql`). Non-matching files are ignored. */
export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort() // lexical sort of zero-padded NNNN prefixes == numeric order
  return files.map((name) => {
    const version = name.match(/^(\d+)/)![1]!
    const path = join(dir, name)
    return { version, name, path, sql: readFileSync(path, 'utf8') }
  })
}

export async function run() {
  const dsn = process.env.DATABASE_URL
  if (!dsn) {
    // Fail loudly — never a silent/fake success when the dependency (the DB) is absent.
    console.error('FATAL: DATABASE_URL is not set. This runner refuses to fake success.')
    process.exit(2)
  }

  const dir = migrationsDir(process.argv.slice(2))
  const migrations = loadMigrations(dir)
  if (migrations.length === 0) {
    console.error(`FATAL: no migrations found in ${dir}`)
    process.exit(2)
  }

  const redacted = dsn.replace(/:[^:@/]*@/, ':***@')
  console.log(`apply-migrations → ${redacted}`)
  console.log(`  dir: ${dir}`)
  console.log(`  found ${migrations.length} migration(s): ${migrations.map((m) => m.name).join(', ')}`)

  const sql = new SQL(dsn)
  try {
    // Ledger of applied migrations. In its own schema-qualified table so it survives a `SET search_path`.
    await sql`CREATE SCHEMA IF NOT EXISTS app`
    await sql`
      CREATE TABLE IF NOT EXISTS app.schema_migrations (
        version     text        PRIMARY KEY,
        name        text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `

    const appliedRows = await sql`SELECT version FROM app.schema_migrations`
    const applied = new Set(appliedRows.map((r: { version: string }) => r.version))

    let ran = 0
    for (const m of migrations) {
      if (applied.has(m.version)) {
        console.log(`  = ${m.name} (already applied)`)
        continue
      }
      console.log(`  ▶ applying ${m.name} ...`)
      // One transaction per file: the whole migration commits or rolls back atomically, then the ledger row.
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql)
        await tx`INSERT INTO app.schema_migrations (version, name) VALUES (${m.version}, ${m.name})`
      })
      console.log(`    ✓ ${m.name} applied`)
      ran++
    }

    console.log(`done: ${ran} newly applied, ${migrations.length - ran} already present.`)
  } catch (e) {
    console.error(`FATAL: migration failed: ${e instanceof Error ? e.message : String(e)}`)
    await sql.close().catch(() => {})
    process.exit(1)
  }
  await sql.close().catch(() => {})
}

// Only run when invoked directly (so tests can import loadMigrations without side effects).
if (import.meta.main) {
  run().catch((e) => {
    console.error('UNEXPECTED', e)
    process.exit(1)
  })
}
