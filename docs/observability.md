# Observability — logs & traces

> Status: **real and wired** (2026-07). Structured logging is live in all four backend services + the Python
> voice-bot. The hosted backend is **Google Cloud Operations** (Cloud Logging + Cloud Trace) — matching
> `docs/PLAN.md` §11 and the IAM already granted in `infra/terraform/iam.tf`. On Cloud Run, logs need zero
> config (stdout is captured automatically); trace export is additive. This doc is the source of truth for
> how logging/tracing works in Voxi.

## TL;DR

- **One decision keeps us cheap and un-lockable:** every service speaks **OpenTelemetry (OTLP)**. App code
  never names a vendor — swapping backends is one env var.
- **Local = stdout, always.** Every log is one line of NDJSON on stdout. No infra required to "capture logs
  locally" — a terminal pane, `docker logs`, or a file redirect is the capture. Cloud Run forwards stdout
  for free too.
- **Hosted = Google Cloud Operations.** We deploy to Cloud Run, so **logs need zero config**: Cloud Run
  captures stdout and Cloud Logging parses each NDJSON line into a structured `jsonPayload` you can filter
  on. **Traces** go to **Cloud Trace** (`roles/cloudtrace.agent` is already granted) — populated additively
  (an OTel Collector sidecar or OTLP → `telemetry.googleapis.com`; see below). No separate logging vendor,
  no OTLP endpoint to set for logs, no metered surprise.
- **RCA is the main use case.** Every request gets a W3C `traceId`; it propagates across service hops and is
  stamped on every log line. Ask "give me everything for trace X" and you get the whole photo → BFF → eve
  front → poller chain. Query it with `gcloud logging read` / the **Logs Explorer** — and Claude Code can run
  those `gcloud` commands directly through Bash during an incident (no MCP required).

## Architecture

```
 voxi-api (bff)      eve-agent (front/poller)     podcast-worker      voice-bot (python)
      │                        │                        │                     │
      └──── @voxi/telemetry ───┴──── (stdout NDJSON always) ────┴─ voxi_voice.telemetry ─┘
                               │
                               │
     HOSTED (Cloud Run):       │  stdout ─────────────────► Cloud Logging   (automatic, zero config)
                               │  OTLP/HTTP (traces) ──────► Cloud Trace     (via collector sidecar / telemetry.googleapis.com)
                               │
     LOCAL (optional):         │  OTLP/HTTP (if OTEL_EXPORTER_OTLP_ENDPOINT set)
                               ▼
                Grafana Alloy ──► Loki + Tempo ──► Grafana   (infra/observability/ docker-compose)
```

- **`packages/telemetry`** (`@voxi/telemetry`) — zero-dependency TS logger. Writes NDJSON to stdout and,
  when configured, ships OTLP/HTTP logs + one SERVER span per request. It implements the OTLP protobuf-JSON
  wire format directly over `fetch`, so there is **no `@opentelemetry/*` SDK** to install or break under Bun.
- **`services/voice-bot/voxi_voice/telemetry.py`** — the Python twin, stdlib-only (keeps the voice-bot's
  `dependencies = []` invariant). Same NDJSON shape; OTLP export via `urllib` on a daemon thread.
- **`infra/observability/`** — the OPTIONAL **local-only** stack (**Grafana Alloy** as the OTLP collector +
  Loki + Tempo + Grafana). It exists purely so you can see trace waterfalls while developing without
  deploying to a GCP project. **Prod does not use it** — prod is Cloud Logging + Cloud Trace. (We use Alloy
  rather than `otel-collector-contrib` because that image is `FROM scratch` and fails to exec on some Docker
  Desktop setups; Alloy's Debian-based image runs everywhere and is Grafana-native.)

### What you get today vs. later

| | Today | Later (additive) |
|---|---|---|
| Structured logs → Cloud Logging | ✅ automatic on Cloud Run (stdout NDJSON → `jsonPayload`) | emit `logging.googleapis.com/trace` for native log↔trace linking in the console |
| Cross-service trace id | ✅ propagated via `traceparent`, stamped on every log line | |
| One SERVER span per hop → Cloud Trace | span is emitted by the logger; **populate Cloud Trace** by pointing OTLP at a collector sidecar / `telemetry.googleapis.com` | |
| DB / downstream-fetch child spans | | add the OTel SDK auto-instrumentation — same exporter, same logger |

Logs are the immediate, free win (nothing to wire on Cloud Run). Cloud Trace population is the one additive
step: the app already produces one server span per hop over OTLP — it just needs an OTLP sink that speaks to
GCP (a collector sidecar with the `googlecloud` exporter, or GCP's OTLP endpoint with a metadata-server
token). Deeper child spans are a further follow-up (`bun add @opentelemetry/sdk-node
@opentelemetry/auto-instrumentations-node`) and require no change to the logger.

## Using it in code

```ts
import { initTelemetry, logger, withRequestTelemetry, outboundHeaders, bindContext } from '@voxi/telemetry'
// (the repo imports via relative path: ../../../packages/telemetry/src/index)

initTelemetry({ service: 'voxi-api', role: 'bff' })      // once, at the entrypoint

Bun.serve({ fetch: withRequestTelemetry(handler, { role: 'bff' }) })   // access log + span + trace context

// inside a handler, after auth — enrich the whole request's logs/span:
bindContext({ userId })

logger.info('scan metered', { scanId, cost })            // inherits traceId/userId automatically
logger.error('cascade failed', err, { stage: 'vision' }) // Error as 2nd arg

// propagate the trace to a downstream service:
await fetch(eveUrl, { headers: outboundHeaders({ authorization: token }) })
```

Python:

```python
from voxi_voice.telemetry import get_logger
log = get_logger("voxi-voice", role="voice")
log.info("offer accepted", pc_id=pc_id, has_item_context=bool(item_context))
log.error("pipeline failed", err=exc)
```

**Redaction is automatic.** Sensitive keys (`authorization`, `token`, `*secret*`, `continuationToken`, …) are
replaced with `[redacted]`, and photo data-URIs / oversized strings are neutralised — a repo rule is that
bodies are never logged.

## Running it

### Local — one command
`./scripts/dev.sh` starts the 4 services and, if Docker is present, the **optional** local Grafana stack, and
points the services at it. This is a dev convenience only — it is *not* the prod backend; it just lets you see
trace waterfalls without deploying to GCP.
```sh
./scripts/dev.sh                  # services + (optional) local Grafana Alloy/Loki/Tempo/Grafana; panes ship OTLP → :4318
open http://localhost:3000        # local Grafana (anonymous admin) → Explore → Loki / Tempo
./scripts/dev.sh down             # stop EVERYTHING (services + stack) in one go
```
Logs are NDJSON in each tmux pane too (pipe through `jq` for pretty output). No Docker? The script skips the
stack and services still log to stdout. (It uses `docker compose` — the v2 plugin, with a space; the old
hyphenated `docker-compose` v1 binary is not installed.)

### Hosted — Google Cloud (Cloud Run)
**Logs: nothing to wire.** Cloud Run captures each service's stdout and Cloud Logging parses the NDJSON into a
structured `jsonPayload`. `roles/logging.logWriter` is already granted to every workload
(`infra/terraform/iam.tf`). Deploy and the logs are in the Logs Explorer.

**Traces: one additive step.** The logger emits one OTLP server span per hop; Cloud Trace just needs an OTLP
sink. `roles/cloudtrace.agent` is already granted. Pick one:
- **Collector sidecar** — run the OpenTelemetry Collector alongside each service with the `googlecloud`
  exporter, and set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` on the app container.
- **GCP OTLP endpoint** — point `OTEL_EXPORTER_OTLP_ENDPOINT` at `https://telemetry.googleapis.com` with a
  metadata-server bearer token + `x-goog-user-project`. (Our zero-dep exporter sends *static*
  `OTEL_EXPORTER_OTLP_HEADERS`, so this path wants either a token-refreshing wrapper or the sidecar above —
  the sidecar is the lower-friction choice today.)

## RCA workflow (the point of all this)

1. A request fails. Grab its `traceId` from any log line (the app can surface it on 5xx responses).
2. **Logs:** filter Cloud Logging by that id — Logs Explorer, or from the CLI:
   ```sh
   gcloud logging read 'jsonPayload.trace_id="<traceId>"' --project <project> --format json --freshness 1h
   ```
   You get the whole photo → BFF → eve-front → poller chain in one query.
3. **Traces:** open the id in **Trace Explorer** (Cloud Trace) for the hop waterfall, once trace export is
   wired (above).
4. **Or ask Claude Code** — it can run the `gcloud logging read` above through Bash, no MCP required. (A
   GCP-logging MCP could be added later if the CLI round-trips get tedious.)

### Field reference (what a log line carries)

Cloud Logging parses the stdout NDJSON into `jsonPayload.*`, so you filter on `jsonPayload.<key>`:

| key | meaning |
|---|---|
| `service_name`, `service_namespace` (`voxi`), `deployment_environment` | service / env identifiers |
| `trace_id`, `span_id`, `requestId` | correlation ids (OTLP maps `traceId`/`spanId` → `trace_id`/`span_id`) |
| `userId`, `voxi_role`, plus any fields you log | structured metadata |

The one query that matters — **every log for a trace**:

```sh
gcloud logging read 'jsonPayload.trace_id="<traceId>"' --project <project> --format json
```

> Native log↔trace linking: emit `logging.googleapis.com/trace` =
> `projects/<project>/traces/<traceId>` on each line and the Logs Explorer / Trace Explorer cross-link
> automatically. That's the additive nicety noted in the table above.

**Local dev equivalent** (against the optional stack): in Grafana → Explore → Loki, run
`{service_name="voxi-api"} | trace_id="<traceId>"`; the trace waterfall is under Tempo
(`GET http://localhost:3200/api/traces/<traceId>`).

## Conventions

- **One `initTelemetry({ service, role })` per entrypoint.** `service` is the workspace; `role` distinguishes
  split-topology roles (e.g. eve `front` vs `poller`).
- **Log events, not sentences.** `logger.info('scan metered', { scanId, cost })`, not string interpolation —
  fields are queryable, messages are for humans.
- **`LOG_LEVEL`** gates output (default `info`). Set `debug` locally when chasing something.
- **Never bypass the redactor.** Don't hand-format tokens/photos into a message string; pass structured
  fields and let the redactor do its job.
