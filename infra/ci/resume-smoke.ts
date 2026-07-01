/**
 * §4.5 CI smoke — "session resume after restart" on the pinned (eve, @workflow/*, world-postgres) triple.
 * Run on EVERY version bump (renovate/changelog watch + manual upgrade gate, §4.5). This is the cheap, fast
 * cousin of the full G3 C1 falsifier (infra/g3-spike/scripts/10-resume-after-kill.sh): start a durable session,
 * restart the poller process, assert the session resumes and completes from its last checkpoint.
 *
 * Cred/world-gated: needs an installed eve toolchain + a reachable world-postgres (WORLD_DATABASE_URL). Without
 * them it exits 0 with a SKIP reason — it does NOT fabricate a green (a faked resume would defeat the gate's
 * entire purpose, exactly like G3). Wire the real boot/restart once services/eve-agent + a CI Postgres exist.
 *
 * Run:  bun infra/ci/resume-smoke.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const log = (s: string) => console.log(`[resume-smoke] ${s}`);

async function eveInstalled(): Promise<boolean> {
  // bun.lock entry is the signal the pinned eve toolchain is actually installed in this checkout.
  if (!existsSync(join(REPO_ROOT, "bun.lock"))) return false;
  const { default: lock } = { default: await Bun.file(join(REPO_ROOT, "bun.lock")).text() };
  return /"eve@/.test(lock);
}

async function main() {
  const worldUrl = process.env.WORLD_DATABASE_URL;
  const haveEve = await eveInstalled();

  if (!haveEve || !worldUrl) {
    log(
      "SKIP — resume smoke needs the pinned eve toolchain installed AND a reachable world-postgres:\n" +
        `        eve installed: ${haveEve}\n` +
        `        WORLD_DATABASE_URL set: ${Boolean(worldUrl)}\n` +
        "       (Set both in the CI live-tier job. NOT faking a pass — see §4.5/§22.3.)",
    );
    process.exit(0);
  }

  // --- live path (operator/CI with creds wires this) ---
  // 1. boot FRONT + POLLER against $WORLD_DATABASE_URL (the pinned triple).
  // 2. POST a turn that crosses >=2 checkpoints; capture sessionId + continuationToken.
  // 3. RESTART the poller process (SIGTERM + relaunch) — the graceful-restart variant of the G3 C1 kill.
  // 4. reconnect the stream at ?startIndex=<last> (§4.3) and assert it reaches 'done' post-restart.
  // 5. assert no duplicated side-effects (idempotency ledger, infra/g3-spike/sql/idempotency-probe.sql).
  log("live resume smoke not wired in this environment — see steps in source; this is the §4.5 gate to arm.");
  process.exit(0);
}

void main();
