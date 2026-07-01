/**
 * migrate.ts — the `bun run db:migrate` entrypoint (package.json scripts.db:migrate).
 *
 * The real runner lives in apply-migrations.ts (task #22); this is the thin, documented entrypoint the
 * package.json script and deploy.sh reference by the CLAUDE.md name. It just calls the runner's exported
 * `run()` and propagates a non-zero exit on failure.
 */
import { run } from './apply-migrations.ts'

run().catch((e) => {
  console.error('UNEXPECTED', e)
  process.exit(1)
})
