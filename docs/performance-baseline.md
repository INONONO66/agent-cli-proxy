# Performance Measurement Baseline

This project now exposes low-cardinality runtime latency histograms and a repeatable local baseline script. These are measurement hooks only; they do not rewrite request flow or change API contracts.

## Runtime metrics

`GET /metrics` includes Prometheus-format histograms for:

- `agent_cli_proxy_proxy_request_duration_ms`: proxied request duration from request entry to lifecycle finalization.
- `agent_cli_proxy_ready_check_duration_ms`: uncached `/ready` evaluation duration.

The proxy histogram labels are intentionally bounded: `provider`, `status`, `lifecycle_status`, and `streamed`. Model names, paths, API keys, request IDs, and accounts are not emitted as metric labels.

## Local baseline run

Run the proxy, then capture a local baseline:

```bash
ADMIN_API_KEY="$ADMIN_API_KEY" bun run perf:baseline --url http://127.0.0.1:8317 --iterations 20 --warmup 3 --output perf-baseline.md
```

Use `--json` for machine-readable output. The script probes `/health` and `/ready`; when `ADMIN_API_KEY` is available it also probes `/metrics` with `x-admin-token`.

Treat each report as before/after evidence for a specific environment. Do not use a single laptop run as a production SLO, and do not perform performance rewrites without comparing a captured baseline against a follow-up run.
