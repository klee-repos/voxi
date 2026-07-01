# G3 boot spike — the eve off-Vercel existence proof (`services/eve-agent/g3-spike/`)

> **This is the real existence-proof for the eve agent layer (PLAN §4.4, §18 G3 / C0, §22.3).** It was RUN, not
> described. The result below is the TRUE recorded outcome — including what broke — captured in `RESULT.json`
> and reproducible end-to-end with `scripts/up.sh` + `boot.ts`. Nothing here is mocked green: the durable world
> is the real `@workflow/world-postgres`, the stream round-trip goes through real Postgres LISTEN/NOTIFY, and
> the tools are the same `identify_object`/`safety_gate` the agent runs.

This complements the procedure-only skeleton in `infra/g3-spike/` (which owns the *full* C0–C4 gate against a
live GCP topology). **This directory is the day-1 BOOT proof (C0)** that §22.3 orders FIRST: *does the eve
durable stack even boot and run one photo→session→streamed-turn loop off-Vercel?*

---

## TL;DR — C0 (boot): **PASS. eve boots off-Vercel.**

`bun add eve @ai-sdk/anthropic @workflow/world-postgres ai` **succeeded**, and `boot.ts` ran one full
photo→session→streamed-turn loop against a plain local Postgres with **zero Vercel platform services** —
**all 5 stages PASS, exit 0** (`RESULT.json`). The §22.3 day-1 falsifier did NOT fire; the §4.5 fallback is NOT
triggered by the boot proof.

| Stage | Result | What it proves |
|---|---|---|
| 1. IMPORT eve | **PASS** | `import('eve')` resolves off-Vercel (`defineAgent`/`defineTool` present); no `@vercel/*` in the runtime path |
| 2. WORLD start | **PASS** | `@workflow/world-postgres` `createWorld({connectionString}).start()` boots: graphile-worker poller + LISTEN/NOTIFY on plain Postgres (the §4.4 self-host seam) |
| 3. SESSION + ACL | **PASS** | a durable session (workflow run id) is minted; the channel `makeAuthFn` records ownership and **denies an intruder** streaming it (the §4.3 per-user invariant) |
| 4. TOOLS | **PASS** | the REAL `safety_gate` + `identify_object` cascade run → `2008 Cannondale SuperSix EVO` / CONFIDENT / route=reveal |
| 5. STREAMED-TURN | **PASS** | the Voxi NDJSON turn (`token → confidence_band → token → done`) is written to the durable world stream, read back, and **every line validates against the shared `events.ts` Zod taxonomy**; `?startIndex=` reconnection replays the tail (full=316B, from-index-2=107B) |

---

## What was actually installed (the C4 PIN triple — `pinned-versions.json`)

```
eve@0.17.1                       (vercel/eve — "Filesystem-first framework for durable backend AI agents that run anywhere")
@ai-sdk/anthropic@4.0.4
ai@7.0.9
@workflow/world-postgres@4.2.0   (createWorld; deps: graphile-worker, pg, drizzle-orm, @vercel/queue)
@workflow/world-local@4.2.0
@workflow/world@4.2.0
```

`eve@0.17.1` **is** Vercel's real `eve` framework (repo `github.com/vercel/eve`), confirming the PLAN's premise.
It exposes exactly the documented surface: `defineAgent`, `defineTool`/`defineBashTool`, channels
(`channels/eve.ts`, `channels/auth.ts` with `verifyJwtHmac` + sub-wildcard matching — the Clerk-AuthFn seam),
and the HTTP API `POST /eve/v1/session` + `GET /eve/v1/session/:id/stream` + `continuationToken`. The bundled
docs (`node_modules/eve/docs/agent-config.md`) confirm `experimental.workflow.world = "@workflow/world-postgres"`
selects the self-hosted Postgres world (PLAN §4.2/§4.4).

---

## How to reproduce (laptop / CI, no GCP, no Vercel)

```bash
# 1) bring up a throwaway local Postgres + migrate the durable world (the Cloud SQL analogue)
bash services/eve-agent/g3-spike/scripts/up.sh

# 2) run the boot existence proof
DATABASE_URL=postgres://voxi@127.0.0.1:55432/voxi_world \
  bun services/eve-agent/g3-spike/boot.ts          # → prints PASS/FAIL per stage, exits 0 on C0 pass

# 3) tear down
bash services/eve-agent/g3-spike/scripts/down.sh
```

The install step itself (`bun add eve @ai-sdk/anthropic @workflow/world-postgres ai`) was run in this isolated
scope (its own `package.json` + lockfile, NOT a root workspace member) so it cannot disturb the green root
`bun test`. `node_modules/` and run artifacts are git-ignored.

---

## Honest findings — what broke / what to watch (the point of a spike)

1. **eve CLI needs Node ≥24; this host has Node 20.** `npx eve dev` / `eve start` refuse to run
   (`eve requires Node.js >=24`). The boot proof therefore drives the eve **library + the world API directly
   under Bun** (which resolves `import('eve')` and the world fine) rather than the CLI. *Consequence for prod:*
   pin the runtime to **Node ≥24** on the Cloud Run front + the non-serverless poller, or run under a
   Node-24-compatible toolchain. This does not block self-host; it constrains the base image.

2. **`world.close()` has a Bun-incompatibility on teardown** (`httpAgent.close is not a function`, from
   `@workflow/world-local`'s queue close path). It is a **teardown-only** error — the world boots, runs the full
   stream loop, and persists correctly; only the graceful close throws. `boot.ts` records it as a finding and
   does not let it mask the verdict. *Consequence:* run the poller/front under **Node 24** (not Bun) in prod to
   avoid the Bun-specific close path, or treat close as best-effort. Re-test C1 (resume-after-kill) under Node.

3. **Stream identity is per-`stream_id`, not per-`run_id`.** `getStreamChunks(name, runId)` groups by the
   stream id derived from `name`; two sessions sharing a constant stream name leak each other's chunks. The fix
   (used here) is a **per-session stream name** (`turn-${runId}`) — i.e. one durable stream per turn. Recorded so
   the eve channel/BFF use a per-turn stream name in prod (this also makes the §4.3 `?startIndex=` resume clean).

4. **Version pin to reconcile (vercel/workflow #1416 risk).** npm `latest` resolved
   `@workflow/world-postgres@4.2.0`, but the eve docs example pins `@workflow/world-postgres@5.0.0-beta.x`
   ("pin a version built against the same `@workflow/*`"). The 4.2.0 line booted cleanly here; **before prod,
   pin the exact `(eve, @workflow/*, world-postgres)` triple that eve 0.17.x is built against** and lock it
   (this is C4's job; `pinned-versions.json` records what was actually under test).

5. **`@vercel/*` coupling is benign at runtime.** `@vercel/queue` + `@vercel/oidc` are pulled in as *declared*
   deps of `world-postgres`, but **neither is referenced in the `world-postgres` / `world-local` / `world` dist
   runtime path** (grep-verified) and **neither loaded during the successful boot**. The Postgres world's queue
   is `graphile-worker` (the LISTEN/NOTIFY poller), not a Vercel platform service. So the "zero Vercel platform
   services" claim holds at runtime; the Vercel-namespaced packages are inert protocol/oidc libraries on disk.

---

## What this spike does NOT prove (still owned by `infra/g3-spike/`, needs a live multi-instance topology)

C0 (boot) is the cheapest, first falsifier and it **passed**. The remaining G3 checks need ≥2 processes / a kill
harness / a >60s route and are out of scope for a single-process laptop proof:

- **C1 RESUME** — kill the poller mid-run; a fresh poller resumes from the last checkpoint. (Needs the split
  front/poller processes + a kill; re-run under Node 24 given finding #2.)
- **C2 SKIPLOCKED** — ≥2 pollers, no step double-processed (`SELECT … FOR UPDATE SKIP LOCKED`). graphile-worker
  is present (it uses SKIP-LOCKED natively), so this is expected to hold — but must be load-tested.
- **C3 SELFCALL (>60s route)** — graphile-worker advances runs by HTTP-calling the app's own
  `/.well-known/workflow/v1/flow`; record completes-or-impossible on the Cloud Run topology
  (vercel/workflow #1483 / the ~60s ceiling). Drives the checkpoint-everything constraint (§4.4).
- **C4 PIN + CI green** — lock the exact triple and run the §4.5 resume-test on it.

**S1 schedules:** `schedules/{dedup,promote}` are authored to be **Cloud-Scheduler-drivable via a BFF cron
route** (`DEDUP_CRON.bffRoute` / `PROMOTE_CRON.bffRoute`) independent of eve's `world-postgres` scheduler, so the
moat machinery does not inherit eve's scheduler risk regardless of how C1–C3 land (§22.3 S1).

**S2 Clerk AuthFn:** the channel's `clerkVerifier` is a **networkless** signature check (no per-request fetch);
the boot proof exercised the AuthFn + ownership ACL (stage 3) off-Vercel. The eve package also ships
`verifyJwtHmac` + sub-wildcard matchers in `channels/auth.ts`, the native seam to wire the Clerk JWT verify into
a route-level `AuthFn` (§4.2 / §12).

---

## Verdict

**G3 C0: PASS — the eve durable agent stack BOOTS off-Vercel and runs one photo→session→streamed-turn loop
against a plain Postgres with zero Vercel platform services.** The day-1 existence proof the PLAN ordered first
holds. The §4.5 fallback is not triggered by boot. C1–C4 remain to be run on a live split topology
(`infra/g3-spike/`), with the three findings above (Node ≥24, run under Node not Bun for teardown, pin the
`@workflow/*` triple) folded into that run.
