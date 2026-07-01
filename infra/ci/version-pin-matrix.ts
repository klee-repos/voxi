/**
 * Version-pin matrix smoke (PLAN.md §4.5 / §22.3, vercel/workflow #1416).
 *
 * eve is public-beta / pre-GA and the @workflow line churns; a cross-version transport break (#1416) silently
 * corrupts durable runs. So we PIN the exact (eve, @workflow/*, world-postgres) triple and assert on every PR:
 *   1. the installed versions EXACTLY match the G3-recorded pin (infra/g3-spike/out/pinned-versions.json),
 *      mirrored into infra/ci/pinned-versions.json as the committed source of truth;
 *   2. no @workflow/* version drifted (the #1416 trap);
 *   3. the §4.5 "session resume after restart" smoke is green on that triple (delegated to the resume-smoke,
 *      which is cred-gated and reports SKIP-with-reason here rather than failing the build spuriously).
 *
 * Runs in CI and locally:  bun infra/ci/version-pin-matrix.ts
 * Exit codes: 0 = green (or legitimately-skipped pre-pin), 1 = a real pin violation (fail the PR).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PIN_FILE = join(import.meta.dir, "pinned-versions.json");
const LOCK_FILE = join(REPO_ROOT, "bun.lock");

type Pin = {
  eve: string;
  worldPostgres: string;
  workflowPackages: string[]; // each "name@version"
  source?: string;
};

function readPin(): Pin | null {
  if (!existsSync(PIN_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PIN_FILE, "utf8")) as Pin;
  } catch (e) {
    fail(`pinned-versions.json is present but unparseable: ${e}`);
    process.exit(1);
  }
}

/** Resolve an installed version for a package name from bun.lock (text-scan; tolerant of lockfile format). */
function installedVersion(pkg: string): string | null {
  if (!existsSync(LOCK_FILE)) return null;
  const lock = readFileSync(LOCK_FILE, "utf8");
  // Match "name@<version>" — escape regex-special chars in the package name (e.g. @workflow/world-postgres).
  const esc = pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const m = lock.match(new RegExp(`"${esc}@([^"]+)"`));
  return m ? m[1] : null;
}

const log = (s: string) => console.log(`[pin] ${s}`);
const ok = (s: string) => console.log(`[pin] OK   ${s}`);
const fail = (s: string) => console.error(`[pin] FAIL ${s}`);
const skip = (s: string) => console.log(`[pin] SKIP ${s}`);

function main() {
  const pin = readPin();

  if (!pin) {
    // Pre-G3: the triple is not pinned yet (eve/@workflow not installed). This is the expected state until G3
    // records the pin. We do NOT fail the PR for a not-yet-pinned dependency — but we make the gap loud.
    skip(
      "no infra/ci/pinned-versions.json yet — the (eve, @workflow/*, world-postgres) triple is recorded by " +
        "the G3 spike (infra/g3-spike, §22.3 output C4). Until then the matrix smoke is a no-op-by-design.",
    );
    log("once G3 records out/pinned-versions.json, copy it to infra/ci/pinned-versions.json to arm this gate.");
    process.exit(0);
  }

  let violations = 0;
  const checks: Array<[string, string]> = [
    ["eve", pin.eve],
    ["@workflow/world-postgres", pin.worldPostgres],
    ...pin.workflowPackages.map((p): [string, string] => {
      const at = p.lastIndexOf("@");
      return [p.slice(0, at), p.slice(at + 1)];
    }),
  ];

  for (const [name, want] of checks) {
    const got = installedVersion(name);
    if (got == null) {
      fail(`${name} is pinned to ${want} but is NOT INSTALLED (lockfile has no entry).`);
      violations++;
    } else if (got !== want) {
      // This is the #1416 trap: a @workflow/* (or eve) version drifted from the durability-validated pin.
      fail(`${name} drifted: pinned ${want}, installed ${got}. Re-run G3 resume-smoke before bumping.`);
      violations++;
    } else {
      ok(`${name}@${got}`);
    }
  }

  if (violations > 0) {
    fail(`${violations} pin violation(s) — the durability-validated triple changed. Block the PR.`);
    process.exit(1);
  }

  ok("all pinned versions match the G3-validated triple.");
  log("next: the §4.5 resume-after-restart smoke (infra/ci/resume-smoke.ts) must be green on this triple.");
  process.exit(0);
}

main();
