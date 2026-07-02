# infra/ci — Voxi CI (PR gate + version-pin matrix, §4.5/§14)

Real CI config + runnable smoke scripts for the web/backend tier and the eve version-pin gate. The workflow
YAML lives here under `infra/ci/workflows/` because **infra is the only tree this workflow owns**; the repo
owner activates them by copying/symlinking into `.github/workflows/` (GitHub only runs workflows from there).

```
infra/ci/
  workflows/
    pr.yml             # every PR: bun test + web E2E runners + lint:selectors + (no-op-pre-pin) matrix smoke
    version-bump.yml   # eve/@workflow/world-postgres bumps: real resume-after-restart on a Postgres service
  version-pin-matrix.ts  # asserts installed (eve,@workflow/*,world-postgres) == the G3-recorded pin (#1416 trap)
  resume-smoke.ts        # §4.5 "session resume after restart" smoke (cred/world-gated; SKIPs, never fakes green)
  pinned-versions.json   # (created at G3 time) the committed source-of-truth triple — armed gate when present
```

## What `pr.yml` runs (the green-here surface, no creds)

Mirrors IMPLEMENTATION-STATUS "Verified runs" — each command below is **proven green in this repo**:

| Step | Command | Covers |
|---|---|---|
| typecheck | `bun run typecheck` | `tsc -b` across the workspace |
| unit + contract | `bun test` | 50+ tests: honesty gate (RT-1), arbitration, metering idempotency, visibility ACL, CSAM→redact intake ordering, NDJSON contract, vendor record/replay, … |
| selector lint | `bun run lint:selectors` | no coordinate taps / unstable selectors in committed scenarios |
| web E2E (golden) | `bun e2e/web/run-auth.web.ts` | auth-01, id-03 (PROBABLE), sub-01 (scan cap→paywall) vs real BFF |
| web E2E (agentic) | `bun run e2e:web:agentic` | an agent drives the REAL screens by perception (real sign-in, shutter, drawer nav), every outcome pinned deterministically |
| web E2E (coverage) | `bun e2e/web/run-coverage.web.ts` | settings/signout/delete-cascade + offline banner |

Vendor calls are **replayed** (`VOXI_E2E_MODE=replay`), DB is seeded, clock/ids frozen via `VOXI_TEST_MODE=1`
+ `x-voxi-test-seed` — deterministic, no creds. The live tier (`--live`, real Gemini/Clerk/etc.) is **not** in
the PR gate.

## The version-pin matrix (§4.5, the #1416 trap)

`version-pin-matrix.ts` is the **CI smoke test on every bump** that §4.5 requires. eve is public-beta/pre-GA
and `@workflow/*` churns; a cross-version transport break (vercel/workflow #1416) silently corrupts durable
runs. So:

1. The exact `(eve, @workflow/*, world-postgres)` triple is **pinned** in `pinned-versions.json` — this file is
   produced by the **G3 spike** (`infra/g3-spike/scripts/40-record-pin.sh` → `out/pinned-versions.json`, the
   §22.3 C4 output) and copied here as the committed source of truth.
2. On every PR, the matrix asserts the **installed** versions in `bun.lock` exactly equal the pin. Any drift →
   **the PR fails** ("re-run G3 resume-smoke before bumping").
3. **Pre-pin (today):** there is no `pinned-versions.json` and eve/@workflow are not installed yet (G3 gates
   them). The matrix is therefore **a no-op-by-design** (SKIP, exit 0) — verified locally. It arms itself
   automatically the moment the pin file appears.

`version-bump.yml` is the **manual upgrade gate**: on a dep PR touching the triple it spins up a real
`pgvector/pgvector` Postgres service and runs `resume-smoke.ts` (the §4.5 "session resume after restart")
against the pinned triple. Like the G3 spike, `resume-smoke.ts` **SKIPs with a reason** when the eve toolchain
or a world isn't present — it never fabricates a green, because a faked resume smoke would defeat the gate.

## Wiring G3 ↔ CI

```
infra/g3-spike (the existence proof)            infra/ci (the standing gate)
  scripts/40-record-pin.sh                         version-pin-matrix.ts
    └── out/pinned-versions.json  ── copy ──▶  pinned-versions.json
  scripts/10-resume-after-kill.sh (C1 kill)        resume-smoke.ts (the §4.5 restart cousin, per-bump)
  scripts/20-multipoller-skiplocked.sh (C2)        version-bump.yml step 3 (best-effort SKIP-LOCKED probe)
```

## Activation

```bash
mkdir -p .github/workflows
cp infra/ci/workflows/pr.yml           .github/workflows/pr.yml
cp infra/ci/workflows/version-bump.yml .github/workflows/version-bump.yml
```

(or symlink). GitHub Actions only executes from `.github/workflows/`; keeping the source under `infra/ci/`
keeps this workflow's edits inside the tree it owns.
