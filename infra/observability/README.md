# infra/observability — local logs & traces stack

The **offline** analogue of Grafana Cloud: Grafana Alloy (OTLP collector) + Loki (logs) + Tempo (traces) +
Grafana, for querying telemetry locally without touching the cloud. Prod does **not** use this — prod ships
OTLP straight to Grafana Cloud. Full design & RCA workflow: [`docs/observability.md`](../../docs/observability.md).

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

## Grafana MCP (query from Claude Code)

To let Claude Code query this local stack, mint a Grafana service-account token
(**Administration → Users and access → Service accounts → Add token**) and set, in `.env.local`:

```
GRAFANA_URL=http://host.docker.internal:3000
GRAFANA_SERVICE_ACCOUNT_TOKEN=<token>
```

The `grafana` MCP server is declared in the repo-root `.mcp.json`.
