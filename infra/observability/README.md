# infra/observability — local logs & traces stack

An **optional, local-only** telemetry stack: Grafana Alloy (OTLP collector) + Loki (logs) + Tempo (traces) +
Grafana, for querying telemetry on your machine without deploying to a GCP project. Prod does **not** use
this — prod is **Google Cloud Operations** (Cloud Logging captures Cloud Run stdout; Cloud Trace holds the
traces). Full design & RCA workflow: [`docs/observability.md`](../../docs/observability.md).

## Quick start

```sh
docker compose -f infra/observability/docker-compose.yml up -d     # alloy :4318, grafana :3000
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 ./scripts/dev.sh # point the app services at the collector
open http://localhost:3000                                         # Grafana (anonymous admin) → Explore
```

- **Logs:** Explore → *Loki* → `{service_namespace="voxi"}`.
- **Traces:** Explore → *Tempo* → search, or paste a `traceId`. Click a span → logs for that span.
- **Stop:** `docker compose -f infra/observability/docker-compose.yml down` (add `-v` to wipe volumes).

## Files

| file | what |
|---|---|
| `docker-compose.yml` | the 4-service stack on disposable volumes |
| `config/alloy.alloy` | Grafana Alloy: one OTLP ingress → Loki (logs) + Tempo (traces) |
| `config/loki.yaml` | single-binary Loki, filesystem, native OTLP + structured metadata |
| `config/tempo.yaml` | local Tempo, OTLP receiver |
| `config/grafana-datasources.yaml` | Loki + Tempo datasources, cross-linked (log ↔ trace via `trace_id`) |

## Querying from Claude Code

There is no Grafana MCP wired — prod RCA is done against Cloud Logging via the `gcloud` CLI (see
`docs/observability.md`). For this optional local stack, just open Grafana at http://localhost:3000
(anonymous admin) → Explore → Loki / Tempo. If you want the agent to query the local stack directly you can
add an `mcp/grafana` server to `.mcp.json` pointed at `GRAFANA_URL=http://host.docker.internal:3000` with a
local service-account token, but that's a personal opt-in, not part of the repo default.
