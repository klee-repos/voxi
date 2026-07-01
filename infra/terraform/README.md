# Voxi infrastructure (Terraform)

Real IaC for the Voxi GCP backend. One project, one region (PLAN §11). Everything
here is authored, not applied — there are no creds in this sandbox. `terraform
plan/apply` is run by whoever holds the project.

> **Scope note:** this directory builds ONLY the infra. The application code it
> references (`voxi-api` BFF, `eve-agent`, `voxi-podcast-worker`, the Pipecat
> `voice-bot`) lives under `services/` and is owned by sibling workflows. Infra
> references those by image name; it does not build them.

---

## The headline: the eng-F1 eve split (PLAN §4.4, GATE G3)

The single most important thing this Terraform encodes is the **corrected eve
topology**. `@workflow/world-postgres` **does not run on serverless** — it needs
a long-lived poller holding a `LISTEN/NOTIFY` loop. So the eve deployment is
**split into two halves with different runtimes**:

| Half | File | Runtime | Scaling | Why |
|---|---|---|---|---|
| **eve request FRONT** | `cloudrun_eve_front.tf` | Cloud Run **service** (serverless) | autoscaled, N≥1 OK | stateless HTTP channel/streaming; holds no poll lease |
| **eve workflow POLLER** | `eve_poller.tf` (+ `modules/eve-poller-gce/`) | **NON-serverless** | **pinned**, never traffic-driven | owns the durable `LISTEN/NOTIFY` poll loop |

The poller runtime is selectable via `var.eve_poller_runtime`:

- `"worker_pool"` → `google_cloud_run_v2_worker_pool` with
  `scaling.manual_instance_count`. A Worker Pool has **no HTTP ingress and is not
  request-driven** — exactly why it fits a durable poll loop. (Preferred.)
- `"gce"` → a **size-pinned managed instance group** (`modules/eve-poller-gce`)
  of Container-Optimized OS nodes. `target_size` is fixed and **no
  `google_compute_autoscaler` is attached** — the number of poll loops is fixed,
  not traffic-driven. Autohealing replaces a wedged node *without* changing the
  size (failover, not scale-out). (Portable fallback.)

A plain Cloud Run **service** with `min-instances=1` is **NOT** used for the
poller: that is "necessary but not sufficient" (no instance pinning; N>1
instances would each poll). That mistake is the whole reason for this split.

### Instance count & lease semantics

`var.eve_poller_instance_count` defaults to **1** (single poller + documented
failover). Raise above 1 **only after G3** confirms `@workflow/world-postgres`
leases work items via `SELECT … FOR UPDATE SKIP LOCKED`; the container reads
`EVE_POLLER_LEASE_MODE` (`single` vs `skip_locked_multi`), which Terraform sets
from the count.

### The self-callback caveat (PLAN §4.4, encoded in `cloudrun_eve_front.tf`)

graphile-worker advances runs by HTTP-calling the app's **own**
`/.well-known/workflow/v1/flow`, which has a **~60s route ceiling**. So:

- **(a)** the eve container serves **both** `/eve/*` **and**
  `/.well-known/workflow/*` (`EVE_ROUTE_PREFIXES`); the front's request timeout
  is capped at **55s** so a turn that tries to run one long opaque step fails
  loudly instead of silently breaching the ceiling.
- **(b)** the front can reach its **own base URL** (`EVE_SELF_BASE_URL`), and its
  SA has `run.invoker` on itself (`eve_front_self_callback`). The poller drives
  the same surface and is granted `run.invoker` on the front too.
- **(c)** genuinely long work (the podcast render) is offloaded to the **async
  Cloud Tasks worker** (`cloudtasks.tf` → `cloudrun_podcast_worker.tf`), never
  run inline in an eve step.

### Why this is gated (G3 is a hard go/no-go)

PLAN §16/D1 demotes eve self-host to **spike-gated & contested**. Gate G3 (§18)
must pass **before** any backend feature work. If G3 fails, the pre-committed
fallback (§4.5) is our own durable-session layer over Postgres + a queue +
continuation tokens — a **re-architecture**, ~30–50% reuse, not a drop-in. This
Terraform provisions the substrate either way (Postgres, queue, the pinned
poller node), so a G3 failure is a code change, not an infra rebuild.

---

## File map

| File | Builds |
|---|---|
| `versions.tf` | provider + Terraform pins; GCS remote state backend |
| `variables.tf` | every knob (project, images, the front/poller split, DB, buckets, queue, secrets) |
| `main.tf` | providers, enabled APIs, VPC + subnet, **Serverless VPC connector**, PSA range, Cloud NAT, one SA per workload |
| `cloudsql.tf` | Cloud SQL Postgres + pgvector; the **single DB** holding `workflow.*` **+** `app.*`; generated DB users; DB-URL secret versions |
| `alloydb.tf` | AlloyDB (ScaNN) migration target, `count=0` until the **eng-F4 measured trigger** |
| `cloudrun_voxi_api.tf` | the **voxi-api BFF** — the **only public surface** |
| `cloudrun_eve_front.tf` | the **eve FRONT** (serverless half) + self-callback wiring |
| `eve_poller.tf` | the **eve POLLER** (non-serverless half): Worker Pool *or* GCE module |
| `modules/eve-poller-gce/` | size-pinned MIG fallback for the poller (+ `cloud-init` that pulls the DB URL from Secret Manager at boot) |
| `cloudrun_podcast_worker.tf` | `voxi-podcast-worker` (async ffmpeg/TTS), private, Cloud-Tasks-invoked |
| `storage_cdn.tf` | GCS `voxi-photos` (private/redacted, **never** on CDN), `voxi-audio` (global path behind **Cloud CDN**), `voxi-csam-quarantine` (retention-locked), access-log bucket |
| `cloudtasks.tf` | the podcast-render queue + enqueuer/actAs IAM |
| `secrets.tf` | Secret Manager **containers** (Clerk, DB URLs, vendor keys) + least-privilege accessor IAM |
| `iam.tf` | cross-cutting grants: Cloud SQL client, per-bucket GCS access, Vertex/Vision, signBlob, logging/trace |
| `outputs.tf` | URLs, bucket names, SA emails, poller runtime (no secrets) |
| `terraform.tfvars.example` | copy → `terraform.tfvars` |

---

## Public-surface invariant (PLAN §3)

Only `voxi-api` has `INGRESS_TRAFFIC_ALL` + `allUsers` `run.invoker`. Everything
else is `INGRESS_TRAFFIC_INTERNAL_ONLY` and invocable only by its named caller
SA:

- **eve front** ← invoked by the BFF SA, the eve-front SA (self-callback), and
  the poller SA.
- **podcast worker** ← invoked only by the Cloud Tasks invoker SA (OIDC).
- **Cloud SQL** ← private IP only (`ipv4_enabled=false`), reached via the VPC
  connector / in-VPC poller.

## Secrets (PLAN §11/§12)

Terraform creates **empty** secret containers and the IAM to read them. It does
**not** set values — except the two DB URLs, which it generated the passwords
for (`google_secret_manager_secret_version` in `cloudsql.tf`). Add the rest
out-of-band:

```sh
gcloud secrets versions add clerk-secret-key      --data-file=-   # paste, Ctrl-D
gcloud secrets versions add clerk-jwt-key         --data-file=-   # CLERK_JWT_KEY (voxi-api/auth.ts)
gcloud secrets versions add url-signing-key       --data-file=-   # VOXI_URL_SIGNING_KEY (signing.ts)
gcloud secrets versions add vertex-ai-key         --data-file=-
gcloud secrets versions add cloud-vision-key      --data-file=-
gcloud secrets versions add elevenlabs-key        --data-file=-
gcloud secrets versions add deepgram-key          --data-file=-
gcloud secrets versions add appstore-connect-api-key --data-file=-  # StoreKit 2 direct, no billing vendor
gcloud secrets versions add photodna-key          --data-file=-
```

Service env-var names are aligned with the code that exists today: the BFF reads
`CLERK_JWT_KEY` (`services/voxi-api/src/auth.ts`) and `VOXI_URL_SIGNING_KEY`
(`services/voxi-api/src/signing.ts`).

## GCS / CDN exposure (PLAN §11, eng-F5)

- `voxi-photos` — `public_access_prevention=enforced`, retention-TTL lifecycle
  (`var.photos_retention_days`, default 90d), **never** fronted by a CDN. Served
  only via short-TTL, user-bound, non-enumerable **signed URLs** the BFF mints
  (it has `serviceAccountTokenCreator` on itself for keyless V4 signing).
- `voxi-audio` — only the **global-by-item-id** path sits behind Cloud CDN
  (`google_compute_backend_bucket … enable_cdn=true`). Per-user audio is not
  written under that prefix.
- `voxi-csam-quarantine` — **retention-locked** 90d (18 U.S.C. 2258A, §15/RT-4),
  write-only for eve, access-logged. Route to NCMEC only, out-of-band.

---

## Usage

```sh
# 0) Bootstrap the remote-state bucket once (chicken/egg — outside this config):
gcloud storage buckets create gs://voxi-tfstate-<project> --location=us-central1

# 1) Init with the backend bucket:
terraform init -backend-config="bucket=voxi-tfstate-<project>"

# 2) Configure:
cp terraform.tfvars.example terraform.tfvars && $EDITOR terraform.tfvars

# 3) Plan / apply:
terraform plan
terraform apply

# 4) Add secret versions (see above), then redeploy services to pick them up.

# 5) Apply the DB schema (workflow.* + app.* + pgvector) via the sibling
#    migrations (owned by packages/db), e.g.:
#    bun packages/db/migrate.ts   # CREATE EXTENSION vector; CREATE SCHEMA app/workflow
```

### Switching the poller runtime

```sh
# Worker Pool (default) -> GCE size-pinned MIG:
terraform apply -var 'eve_poller_runtime=gce'
```

### AlloyDB cutover (only after the eng-F4 measured trigger)

```sh
terraform apply -var 'enable_alloydb=true'
# then: snapshot Cloud SQL, dump+restore app.* into AlloyDB, CREATE INDEX … USING scann,
# repoint database-url-* secrets, redeploy. (Runbook lives with packages/db.)
```

### Before any eve world-schema migration (PLAN §4.5)

Snapshot Cloud SQL first — a world-schema migration is the one op that can
corrupt durable eve sessions. The instance has `prevent_destroy=true` and
`deletion_protection` on; the documented rollback is restore-from-snapshot.

---

## Gaps / things a real apply still needs (honest)

These are deliberately left for whoever holds the project + creds:

1. **No `terraform validate`/`plan` run here** — no GCP creds in this sandbox, and
   the rule set forbids cloud commands. Syntax is hand-checked; a real
   `terraform init && validate` is the first thing to run with a provider.
2. **`google_cloud_run_v2_worker_pool` is a beta-provider resource.** If your
   pinned `google-beta` predates Worker Pool GA, either bump the provider or set
   `eve_poller_runtime="gce"` (the GCE path uses only GA resources).
3. **CDN TLS hostname is a placeholder** (`audio.voxi.example.com` in
   `storage_cdn.tf`). Set the real hostname + DNS before apply, or the managed
   cert won't provision.
4. **`EVE_SELF_BASE_URL`** uses the conventional `run.app` hostname as a stable
   value; the eve app should also read its own URL at runtime
   (`K_SERVICE`/metadata) so the self-callback target is always correct even if
   a custom domain is mapped.
5. **CDN fill SA name** (`cloud-cdn-fill`) is assumed; confirm the exact service
   identity for backend-bucket reads against current GCP docs, or grant via the
   project's CDN service agent.
6. **The DB schema itself** (`CREATE SCHEMA app/workflow`, `CREATE EXTENSION
   vector`, the partitioned global/private HNSW indexes per eng-F4) is applied by
   the sibling `packages/db` migrations, not by Terraform — Terraform only
   creates the instance/DB/users.
7. **Pipecat `voice-bot`** (Python Cloud Run, §6.3) is owned by a sibling
   workflow and not provisioned here; when it lands, it gets a Cloud Run service
   + a BFF-minted per-session scoped token, mirroring the worker pattern.
8. **Remote-state bucket** is created out-of-band (bootstrap step) — Terraform
   can't create the bucket that holds its own state on the first run.
