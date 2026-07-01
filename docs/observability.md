# Observability — logs & traces

> Status: **real and wired** (2026-07). Structured logging is live in all four backend services + the Python
> voice-bot; OTLP export + the Grafana MCP are config-gated (set two env vars). This doc is the source of
> truth for how logging/tracing works in Voxi. See also `docs/PLAN.md` §11.

## TL;DR

- **One decision keeps us cheap and un-lockable:** every service speaks **OpenTelemetry (OTLP)**. App code
  never names a vendor — swapping backends is one env var.
- **Local = stdout, always.** Every log is one line of NDJSON on stdout. No infra required to "capture logs
  locally" — a terminal pane, `docker logs`, or a file redirect is the capture. Cloud Run forwards stdout
  for free too.
- **Hosted = Grafana Cloud (free tier).** Set `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS`
  and the same records ship to Grafana Cloud (Loki for logs, Tempo for traces). Free tier ≈ 50 GB logs +
  50 GB traces, 14-day retention, and it does **not** auto-bill past the cap unless you opt in — so it stays
  flat $0, which is the "no metered surprise" requirement.
- **RCA is the main use case.** Every request gets a W3C `traceId`; it propagates across service hops and is
  stamped on every log line. Ask "give me everything for trace X" and you get the whole photo → BFF → eve
  front → poller chain. The **Grafana MCP** (`.mcp.json`) lets Claude Code query that directly during an
  incident.

## Architecture

```
 voxi-api (bff)      eve-agent (front/poller)     podcast-worker      voice-bot (python)
      │                        │                        │                     │
      └──── @voxi/telemetry ───┴──── (stdout NDJSON always) ────┴─ voxi_voice.telemetry ─┘
                               │
                               │  OTLP/HTTP  (only if OTEL_EXPORTER_OTLP_ENDPOINT set)
                               ▼
                LOCAL: Grafana Alloy ──► Loki + Tempo ──► Grafana   (docker-compose)
                HOSTED: Grafana Cloud OTLP gateway ──────► Grafana Cloud
```

- **`packages/telemetry`** (`@voxi/telemetry`) — zero-dependency TS logger. Writes NDJSON to stdout and,
  when configured, ships OTLP/HTTP logs + one SERVER span per request. It implements the OTLP protobuf-JSON
  wire format directly over `fetch`, so there is **no `@opentelemetry/*` SDK** to install or break under Bun.
- **`services/voice-bot/voxi_voice/telemetry.py`** — the Python twin, stdlib-only (keeps the voice-bot's
  `dependencies = []` invariant). Same NDJSON shape; OTLP export via `urllib` on a daemon thread.
- **`infra/observability/`** — the OPTIONAL local stack (**Grafana Alloy** as the OTLP collector + Loki +
  Tempo + Grafana). Prod does not use it; prod ships straight to Grafana Cloud. (We use Alloy rather than
  `otel-collector-contrib` because that image is `FROM scratch` and fails to exec on some Docker Desktop
  setups; Alloy's Debian-based image runs everywhere and is Grafana-native.)

### What you get today vs. later

| | Today (zero deps) | Later (additive) |
|---|---|---|
| Structured logs | ✅ all services, correlated by traceId | |
| Cross-service trace id | ✅ propagated via `traceparent` | |
| One SERVER span per hop (Tempo waterfall) | ✅ | |
| DB / downstream-fetch child spans | | add the OTel SDK auto-instrumentation — same collector, same logger |

A single server span per hop is enough to answer "what happened in this request across services." Deeper
spans are a clean follow-up (`bun add @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node`) and
require no change to the logger or the backend.

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
`./scripts/dev.sh` starts the 4 services **and** the observability stack, and points the services at it:
```sh
./scripts/dev.sh                  # services + Grafana Alloy/Loki/Tempo/Grafana; panes ship OTLP → :4318
open http://localhost:3000        # Grafana (anonymous admin) → Explore → Loki / Tempo
./scripts/dev.sh down             # stop EVERYTHING (services + stack) in one go
```
Logs are NDJSON in each tmux pane too (pipe through `jq` for pretty output). No Docker? The script skips the
stack and services still log to stdout. (It uses `docker compose` — the v2 plugin, with a space; the old
hyphenated `docker-compose` v1 binary is not installed.)

### Hosted — Grafana Cloud
1. Create a free stack at grafana.com. In the stack: **Connections → Add new connection → OpenTelemetry**.
   It gives you an **OTLP endpoint** and a **base64 token**.
2. Put them in `.env.local`:
   ```
   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp
   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instanceID:token)>
   ```
3. Same two vars go on the Cloud Run services (Terraform / deploy scripts) so prod ships there too.

## RCA workflow (the point of all this)

1. A request fails. Grab its `traceId` from any log line (the app can surface it on 5xx responses).
2. In Grafana → **Explore → Tempo**, open the trace: the full hop waterfall (bff → eve-front → poller).
   Click any span → **"Logs for this span"** to see the correlated log lines.
3. Or ask Claude Code — with the Grafana MCP configured it can run the Loki/Tempo queries for you:
   *"pull the trace `<id>` and its error logs."*

### Field reference (what a log line carries)

Loki's OTLP ingest promotes these to structured metadata you can filter on. **Note the underscored keys** —
OTLP maps `traceId`/`spanId` to `trace_id`/`span_id`:

| key | meaning |
|---|---|
| `service_name`, `service_namespace` (`voxi`), `deployment_environment` | indexed stream labels |
| `trace_id`, `span_id`, `requestId` | correlation ids |
| `userId`, `voxi_role`, plus any fields you log | structured metadata |

The one query that matters — **every log for a trace** (verified end-to-end against the local stack):

```logql
{service_name="voxi-api"} | trace_id="<traceId>"
```

Trace waterfall by id (Tempo API): `GET http://localhost:3200/api/traces/<traceId>`.

### Wiring the Grafana MCP
`.mcp.json` already declares a `grafana` server (runs `mcp/grafana` via Docker). Point it at your instance:
```
GRAFANA_URL=https://<org>.grafana.net          # or http://host.docker.internal:3000 for the local stack
GRAFANA_SERVICE_ACCOUNT_TOKEN=<token>          # Grafana → Administration → Service accounts → Add token
```
Then in Claude Code: `/mcp` to confirm it connected. It exposes tools to query Loki logs, search/inspect
Tempo traces, and read dashboards/alerts.

## Conventions

- **One `initTelemetry({ service, role })` per entrypoint.** `service` is the workspace; `role` distinguishes
  split-topology roles (e.g. eve `front` vs `poller`).
- **Log events, not sentences.** `logger.info('scan metered', { scanId, cost })`, not string interpolation —
  fields are queryable, messages are for humans.
- **`LOG_LEVEL`** gates output (default `info`). Set `debug` locally when chasing something.
- **Never bypass the redactor.** Don't hand-format tokens/photos into a message string; pass structured
  fields and let the redactor do its job.
