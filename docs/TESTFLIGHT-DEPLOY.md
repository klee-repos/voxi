# Voxi → TestFlight + GCP — v1 deploy runbook

Get Voxi running **fully on an iPhone via TestFlight**, backend on **Google Cloud**, telemetry via the existing
**Cloud Logging + Cloud Trace** approach. This is the **simplified v1**: the core loop (auth → photo → identify →
reveal → narrate → durable collection). Voice/podcast/subscriptions are deliberate fast-follows.

Built from a plan that was **adversarially reviewed** (47 findings; 21 blockers). The load-bearing findings were
verified against source and folded in. `docs/IMPLEMENTATION-STATUS.md` remains the honest state tracker.

## v1 architecture (deliberately lean)

```
iPhone (TestFlight) ──https──▶ Cloud Run: voxi-api (BFF)
                                 ├─ in-process CascadeEveClient → Vertex Gemini + Cloud Vision + grounded research
                                 ├─ LiveNarrator + ElevenLabs (spoken reveal)
                                 ├─ durable stores ──unix socket──▶ Cloud SQL (Postgres 16)
                                 └─ structured NDJSON → Cloud Logging;  SERVER span (traceId) per request
```

**Why lean:** `spikes/live-bff-scan.ts` proves the real identify→narrate cascade runs **in-process** in the BFF
(no eve-front / eve-poller / Postgres-workflow-world needed for the core loop). That sidesteps the three hardest
review blockers (poller boot, BFF→eve auth, `EVE_SELF_URL`) entirely and collapses the backend to **one service +
one DB**. The full durable-agent architecture (`infra/terraform/*`) stays intact for the later build-out.

Project `eighth-duality-354701` · region `us-central1` · bundle `com.voxi.app`. The project is **shared** with other
apps, so every Voxi resource is namespaced `voxi-*`.

---

## What is already DONE + VERIFIED (code, this session)

All backend code changes are committed to the working tree and verified: **`bun test` 444/0**, a real-Postgres
smoke of the new Cloud SQL path (14/14), a clean `bun build` of the production entry (224 modules), and a live
boot of the production entry (`/healthz` ok, `/v1/me`→401, structured `traceId` logs).

| Change | File | Why |
|---|---|---|
| Production BFF entry now assembles the **real cascade + Cloud SQL stores + telemetry + spoken reveal** | `infra/docker/voxi-api/server.ts` (rewritten) | Was a stub (`memoryStore`, canned reveal, `console.log`). Now the proven-live path. |
| **Cloud SQL store** over `pg`, reusing the PGlite store logic verbatim | `services/voxi-api/src/cloudsql-stores.ts` (new) + `pg-stores.ts` refactor (`buildPgStores(PgLike)`) | Cloud Run disk is ephemeral/per-instance → PGlite-on-disk split-brains. Collection must live in Cloud SQL. |
| **GCP token via metadata server** on Cloud Run (gcloud fallback locally) | `services/eve-agent/agent/lib/gcp-vision.ts` (`warmGcpToken`) | `gcloud auth print-access-token` doesn't exist in a container — the cascade would 500 in prod. |
| `pg` + `@types/pg` dependency | root `package.json` + `bun.lock` | Cloud SQL driver. |
| Dockerfile copies `eve-agent` + `telemetry` + `db` source | `infra/docker/voxi-api/Dockerfile` | The assembled entry imports them. |
| iOS **version 0.0.0 → 1.0.0**; Info.plist literal → `$(MARKETING_VERSION)`; pbxproj `1.0 → 1.0.0` | `app/app.json`, `app/ios/Voxi/Info.plist`, `app/ios/Voxi.xcodeproj/project.pbxproj` | App Store Connect rejects `0.0.0`. |
| **`eas.json`** scaffolded (build + submit) | `app/eas.json` (new) | EAS path. Two placeholders to fill (BFF url after deploy; ASC ids). |
| **Deploy script** (idempotent) + Cloud Build config | `infra/deploy/voxi-api-v1.sh`, `infra/deploy/cloudbuild.voxi-api.yaml` | One-command backend deploy. |

Auth note: v1 uses the existing Clerk **dev** instance (`pk_test_…`), which **matches** the BFF's `CLERK_JWT_KEY`
in `.env.local`. That's consistent and works for a personal TestFlight. A public launch needs a Clerk **production**
instance (custom domain + DNS) — fast-follow.

---

## PREFLIGHT — you must confirm/decide these (only you can)

1. **Apple Developer Program — is it active + paid ($99/yr)?** The Mac has only an *Apple Development* cert (which
   free accounts also get). The App Store Connect API key in `.env.local` is **empty/placeholder** (verified), so it
   can't confirm enrollment. **Verify:** sign in at <https://developer.apple.com/account> → **Membership** — it must
   show an active *Apple Developer Program* membership and a **Team ID**. TestFlight is impossible without it.
2. **Which team owns `com.voxi.app`?** `project.pbxproj` bakes `DEVELOPMENT_TEAM = DRJEJC9KRM`; the Mac's cert is for
   `4T3BF3VABM`. Tell me which one holds the paid membership; I'll align `app.json` (`ios.appleTeamId`), `pbxproj`,
   and `eas.json` to it.
3. **GCP `gcloud auth application-default login`** (ADC) — needed before the deploy script mutates anything.

---

## REMAINING STEPS (ordered) — who does what

Legend: 🤖 = agent runs · 🔐 = agent runs WITH your go-ahead (billable/outward-facing) · 🧑 = you only (interactive Apple/Google auth, portal).

### Backend (Google Cloud)
1. 🧑 `gcloud auth application-default login` (+ it's already project `eighth-duality-354701`).
2. 🔐 `bash infra/deploy/voxi-api-v1.sh` — enables APIs, creates the AR repo, the runtime SA + IAM, **Cloud SQL**
   (⚠ ~10 min, billable), seeds `voxi-*` secrets from `.env.local`, grants the app user its schema, **builds+pushes**
   the image (Cloud Build), and **deploys Cloud Run**. Prints the `BFF_URL` and curls `/healthz`.
3. 🤖 Pre-flight the live backend before touching the phone: `VOXI_API_URL=$BFF_URL bun spikes/e2e-live-http.ts`.

### iOS → TestFlight (EAS)
4. 🧑 In App Store Connect: create the app record for `com.voxi.app` (needs #PREFLIGHT-1). Note its **numeric ASC app id**.
5. 🧑 ASC → Users and Access → Integrations → create an **App Store Connect API key** (App Manager); download the `.p8`; note Key ID + Issuer ID.
6. 🤖 Fill `app/eas.json`: `EXPO_PUBLIC_API_BASE_URL = <BFF_URL>` (both profiles), `submit.production.ios.ascAppId` + `appleTeamId`.
7. 🧑 `cd app && bun add -d eas-cli && eas login && eas build:configure -p ios` (Expo + Apple login).
8. 🔐 `eas build -p ios --profile production` (EAS mints the Distribution cert + App Store profile the Mac lacks; Apple 2FA).
9. 🔐 `eas submit -p ios --profile production --latest` → then 🧑 assign the build to a TestFlight internal group.

### On-device acceptance (§E)
10. 🧑 Install from TestFlight → sign in → photograph an object → reveal renders → tap "Hear it" → **collection persists** across a force-quit/relaunch.
11. 🤖 Read the request end-to-end in Cloud Logging (note: **camelCase `traceId`**, per the review):
    ```sh
    gcloud logging read 'resource.type="cloud_run_revision" jsonPayload.service="voxi-api" jsonPayload.method!=""' \
      --project eighth-duality-354701 --format json --freshness 15m | head
    # then pull one request: jsonPayload.traceId="<id>"
    ```

---

## Telemetry (Cloud-native, per docs/observability.md)

- **Logs:** the BFF writes one NDJSON line per event to stdout; Cloud Run ships it to **Cloud Logging** automatically
  (zero config). Verified locally: `{service:"voxi-api", traceId, spanId, requestId, method, path, status, ms}`.
- **Traces:** one SERVER span per request (via `withRequestTelemetry`). To land spans in **Cloud Trace** additively,
  set `OTEL_EXPORTER_OTLP_ENDPOINT` to a collector with the `googlecloud` exporter. **v1 ships logs-only** (a
  collector sidecar is a fast-follow); logs already carry `traceId` for correlation. `/healthz` is excluded from spans.

## Risks / cost / open items

- **Cost:** Cloud SQL `db-g1-small` + a running Cloud Run min-instances=0 ≈ **$25–40/mo** (SQL is the fixed cost; the
  BFF scales to zero). Downsize `VOXI_SQL_TIER` or stop the SQL instance between sessions. (Full Terraform would be
  far more — that's why v1 is lean.)
- **Cloud SQL `prevent_destroy`** is only in Terraform; this script's instance is deletable with `gcloud sql instances delete voxi-pg`.
- **Fast-follows (not in v1):** realtime voice (`voice-bot`), two-voice podcast, StoreKit subscriptions, Clerk prod
  instance, a Cloud Trace collector sidecar, and the catalog "moat" (runs ephemeral/degraded in v1).

**Fastest sanity gate before the phone:** step 3 (`e2e-live-http.ts` green against the deployed `$BFF_URL`).
