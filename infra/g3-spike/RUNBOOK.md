# G3 — eve-off-Vercel existence-proof runbook (HARD GATE)

> **Status: spike, not settled fact.** Per PLAN.md §4.4 / §22.3, self-hosting the eve agent layer
> (channels / subagents / skills / sandbox→`justbash` / model→Vertex / secrets→Secret Manager) off Vercel is
> **unproven on the public record**. G3 *is* the existence proof. This runbook is the go/no-go procedure run
> **first** in the build sequence (§20.1), **before** any backend feature work (§20.2). If it fails, the §4.5
> fallback fires immediately and the agent layer is re-architected (PLAN.md §22.3: ~30–50% reuse, not a drop-in).
>
> This directory contains **scripts/skeletons and a procedure**, not a live run. Live execution needs a GCP
> project + billing + Vertex/Secret Manager + a pinned `eve` toolchain — none present in this sandbox
> (IMPLEMENTATION-STATUS.md). Do not "mock it green": the whole point of G3 is that it cannot be faked.

---

## 0. Why this gate exists (the corrected topology, PLAN.md §4.4)

The `@workflow/world-postgres` durable world **does not run on serverless** — it needs a long-lived poller +
LISTEN/NOTIFY. Cloud Run is serverless/autoscaling, so `min-instances=1` is **necessary but not sufficient**
(no instance pinning; every instance N>1 polls). The decision is to **split the deployment**:

| Role | Runtime | Scaling | Owns |
|---|---|---|---|
| **eve FRONT** | Cloud Run (service) | stateless, autoscaled | HTTP channel + NDJSON streaming (`/eve/*`) |
| **eve POLLER** | **non-serverless**: Cloud Run **Worker Pool** (manual scale) **or** a single GCE VM / size-pinned GKE pod | manual / pinned | the `@workflow/world-postgres` graphile-worker poller + LISTEN/NOTIFY |

Self-callback gotcha (PLAN.md §4.4, vercel/workflow #1483): graphile-worker advances a run by **HTTP-calling
the app's own** `/.well-known/workflow/v1/flow`, which sits behind a **~60s route ceiling**. Therefore:
- ingress must forward `/eve/*` **and** `/.well-known/workflow/*`;
- the service must be able to reach **its own base URL** (no split-horizon DNS / private-only ingress that
  blocks the self-call);
- **turns are designed to checkpoint frequently** — a single long synchronous identify+ground+narrate step
  would breach 60s; genuinely-long work (podcast render) is offloaded to the Cloud Tasks worker (§6.2 / D7).

`world-postgres`, `services/eve-agent` (the agent layer), `services/voxi-api` (BFF), and the eve toolchain are
owned by sibling workflows — **this spike references them by name and boots them; it does not author them.**

---

## 1. Acceptance criteria — five named binary checks

G3 passes **only if all five are PASS**. Each is binary and each names the known-bad path it falsifies.

| ID | Check | Falsifies / references | PASS means |
|---|---|---|---|
| **C0 BOOT** | `eve init` → rip out every Vercel adapter → boots and runs **one photo→session→streamed-turn loop** with **ZERO Vercel platform services**, world = `world-postgres` | §22.3 day-1 boot spike | the loop streams a Voxi turn end-to-end; no `@vercel/*` / Vercel KV / Vercel Blob / Vercel-hosted anything in the dependency or runtime path |
| **C1 RESUME** | **session resume after instance kill** — start a turn, **kill the poller instance mid-run**, a fresh poller picks the run up from its last checkpoint and the session completes | infra-01 (TEST-PLAN §13); G3 durability | the streamed turn completes after the kill; `threads.eve_session_id` + continuationToken resume; no duplicated side-effects |
| **C2 SKIPLOCKED** | **multi-poller SKIP-LOCKED correctness** — run **≥2 pollers** against one world; under load **no workflow step is double-processed** | §4.4 "SELECT … FOR UPDATE SKIP LOCKED"; infra-02 | every step executes exactly once; lease semantics documented; OR, if genuinely single-poller, failover + throughput ceiling documented |
| **C3 SELFCALL** | the **>60s self-call** either **completes** on the Cloud Run topology **or is proven impossible** (route ceiling hit) | vercel/workflow #1483 | a result is recorded: "completes" → long steps allowed; "impossible" → **checkpoint-everything is mandatory** and recorded as a constraint |
| **C4 PIN** | the **exact pinned `(eve, @workflow/*, world-postgres)` triple** is recorded as a G3 output, and the §4.5 CI resume-test is **green on that triple** | vercel/workflow #1416 cross-version transport break; §4.5 | a `pinned-versions.json` is emitted and `infra/ci`'s version-pin matrix smoke is green on it |

Two more **checklist** items (not pass/fail blockers, but must be answered and recorded — §22.3):
- **S1 schedules:** do eve `schedules/{dedup,promote}` run under `world-postgres`? Record yes/no. **Cheap
  insurance regardless:** they are spec'd to also be Cloud-Scheduler-drivable via a BFF cron route, so the moat
  machinery does not inherit eve's scheduler risk (§22.3 amends §4.2/§7).
- **S2 Clerk AuthFn:** the eve custom `AuthFn` verifies the Clerk session JWT **networkless** (`@clerk/backend`
  `verifyToken` + JWKS) and enforces per-user session-ownership ACL — confirmed booting off-Vercel (§4.2 / §12).

---

## 2. Preconditions (live run)

- A GCP project + billing; region pinned (PLAN.md §11, one project/region).
- Cloud SQL Postgres + pgvector reachable (the `world-postgres` durable world + `app.*` schema). Snapshot taken
  before any world-schema migration (§4.5 documented rollback).
- Secret Manager populated; Vertex AI enabled (model → `anthropic("claude-sonnet-4-6")` via the brain default,
  §4.2). **NO Vercel account, KV, Blob, or platform service is provisioned** — that absence is the test.
- The pinned eve toolchain installed at the exact triple under test (do **not** float; #1416).
- `services/eve-agent` (agent layer) + `services/voxi-api` (BFF) deployable; ingress forwards `/eve/*` **and**
  `/.well-known/workflow/*` (§4.4).

> All cloud/`bun add`/install steps are **operator actions** (no creds in this sandbox). The scripts below are
> **skeletons** that fail loudly with a clear "operator must do X" message rather than fake a result.

---

## 3. Procedure

### Step C0 — boot proof (the day-1 spike, ordered first)
1. `eve init` a throwaway project (or use `services/eve-agent` once authored).
2. Run `scripts/00-boot-proof.sh` — it asserts the **Vercel-adapter rip** is complete (no `@vercel/*` /
   Vercel KV / Blob in deps or runtime), the world is `world-postgres`, then boots FRONT + POLLER locally
   (docker-compose Postgres) and drives **one photo→session→streamed-turn** through the eve HTTP channel.
3. PASS = a Voxi turn streams end-to-end (`token … done` NDJSON, §4.3) with zero Vercel services. If boot
   fails → **STOP. §4.5 fallback fires.** (§22.3: this is the first, cheapest falsifier.)

### Step C1 — session resume after instance kill (infra-01)
1. `scripts/10-resume-after-kill.sh` starts a turn that crosses ≥2 checkpoints.
2. Mid-run it **kills the poller container/instance** (`docker kill` locally; on GCP, drain/kill the Worker
   Pool replica or the GCE poller VM).
3. A fresh poller starts; the run resumes from its last durable checkpoint; the session completes; the
   streamed turn finishes. PASS = completes after kill, **no duplicated side-effects** (idempotent tool
   results; §4.6 enqueue/embed are idempotent).

### Step C2 — multi-poller SKIP-LOCKED (infra-02)
1. `scripts/20-multipoller-skiplocked.sh` boots **≥2 pollers** on one world and runs the workload generator
   (`scripts/load-gen.ts`) at the pinned turns/sec target (§22.6: target pinned before §20.9).
2. `sql/skip-locked-probe.sql` asserts each workflow step row is claimed by exactly one poller
   (`FOR UPDATE SKIP LOCKED` lease) and is processed exactly once.
3. PASS = zero double-processed steps; lease/heartbeat semantics recorded. If `world-postgres` turns out
   single-poller-only, record the **failover + throughput ceiling** instead (§4.4 fallback branch).

### Step C3 — >60s self-call (vercel/workflow #1483)
1. `scripts/30-selfcall-60s.sh` drives a turn whose single step deliberately exceeds 60s and watches the
   self-call to `/.well-known/workflow/v1/flow`.
2. Record the binary outcome: **completes** (Cloud Run timeout config allowed it) **or** **impossible** (route
   ceiling hit). Either is a valid PASS — but "impossible" makes **checkpoint-everything mandatory** and that
   constraint is written into the eve turn design (§4.4) and `result.json`.

### Step C4 — pin + CI green (vercel/workflow #1416)
1. `scripts/40-record-pin.sh` writes `pinned-versions.json` (the exact eve / `@workflow/*` / `world-postgres`
   triple actually under test, read from the installed lockfile — never hand-typed).
2. Run `infra/ci`'s version-pin matrix smoke (`bun run ci:pin-matrix`) against that triple. PASS = green.

### Checklist S1/S2
- `scripts/50-checklist.sh` records the schedules-under-world-postgres answer and re-asserts the Clerk
  AuthFn boots networkless. (Insurance: Cloud-Scheduler→BFF-cron path is spec'd regardless.)

### Verdict
`scripts/99-verdict.sh` reads each step's recorded outcome from `out/` and prints **G3: PASS** only if
C0–C4 are all PASS, emitting `out/result.json`. Any FAIL → **G3: NO-GO → §4.5 fallback**, and §20.2 backend
feature work stays blocked.

---

## 4. Outputs (consumed by the gate + sibling workflows)

- `out/pinned-versions.json` — the G3 pinned triple (feeds `infra/ci` matrix + the §4.5 thin-adapter).
- `out/result.json` — `{ C0..C4: pass|fail, C3_mode: "completes"|"impossible", S1_schedules, throughput }`.
- The status flip of `services/eve-agent` from "scaffolded (gated on G3)" to real — **only on PASS** (status
  tracked by a sibling workflow; this spike supplies the evidence).

## 5. If G3 fails — the pre-committed response (§4.5 / §22.3)

Fire the fallback: **our own durable-session layer over Postgres + a queue + continuation tokens.** It reuses
the `threads` row but **abandons the eve agent-framework model** (subagents/skills/channels) and re-implements
durable checkpointing/leasing — **~30–50% reuse**, with an explicit **"re-architect the agent layer"** line
item cascading into §4.2 / §6.2. The thin `@workflow/*` adapter (§4.5) contains the blast radius to one module.
