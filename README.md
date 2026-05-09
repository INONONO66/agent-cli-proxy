# agent-cli-proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/agent-cli-proxy.svg)](https://www.npmjs.com/package/agent-cli-proxy)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)

AI API proxy with per-tool usage monitoring. Sits between AI coding tools (OpenCode, OpenClaw, Hermes) and upstream API providers, tracking usage per tool and per instance, computing token costs from live pricing data, and mapping CLIProxyAPI accounts to subscription plans for cost monitoring. Runs as a native Bun process. Self-hosted, no containers needed.

## Why this exists

Most AI coding tools share a single upstream API key, making it impossible to know which tool or session is responsible for a given cost spike. agent-cli-proxy intercepts every request, identifies the originating tool from request headers, and records per-tool usage with accurate cost attribution from models.dev pricing data. It also maps CLIProxyAPI accounts to subscription plans so you can monitor spend against plan limits without any enforcement overhead.

## Install

### No global install (recommended for one-off use)

```bash
bunx agent-cli-proxy init
```

### Global install via npm

```bash
npm i -g agent-cli-proxy
agent-cli-proxy init
```

### From source

```bash
git clone https://github.com/<owner>/agent-cli-proxy.git
cd agent-cli-proxy
bun install
bun run build
bun run src/cli.ts init
```

## Quickstart

1. **Initialize** — creates config, database, and prompts for optional features:

   ```bash
   agent-cli-proxy init
   ```

2. **Install the daemon** — registers a systemd user service (Linux) or launchd agent (macOS):

   ```bash
   agent-cli-proxy service install
   ```

3. **Start the service**:

   ```bash
   agent-cli-proxy service start
   ```

4. **Send a request** — point your AI tool at `http://127.0.0.1:3100` instead of the upstream API.

5. **Check health and usage**:

   ```bash
   curl http://127.0.0.1:3100/health
   curl http://127.0.0.1:3100/admin/usage/today
   ```

The installer creates OS-appropriate local paths by default:

| Purpose | Default |
|---------|---------|
| Config | `~/.config/agent-cli-proxy/.env` |
| Data / SQLite | `~/.local/share/agent-cli-proxy/proxy.db` |
| Runtime bundle | `~/.local/share/agent-cli-proxy/runtime` |
| Linux daemon | `~/.config/systemd/user/agent-cli-proxy.service` |
| macOS daemon | `~/Library/LaunchAgents/ai.agent-cli-proxy.plist` |

`agent-cli-proxy init` asks which optional features to enable and writes only the needed settings. Existing `.env` files are not overwritten unless you pass `--force`; use `--merge` to keep existing values while adding missing defaults.

Optional features prompted during init:

- Dashboard login (`DASHBOARD_PASSWORD_HASH`)
- Admin API token (`ADMIN_API_KEY`) when exposing beyond loopback
- CLIProxyAPI account correlation (`CLIPROXY_MGMT_KEY`)
- SQLite/pricing cache paths

Provider API keys are intentionally **not** stored by this proxy. The proxy routes through CLIProxyAPI; configure provider credentials there.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `3100` | Proxy server port |
| `PROXY_HOST` | `127.0.0.1` | Bind host. Keep loopback unless you add auth/network controls. |
| `ADMIN_API_KEY` | | Required when `PROXY_HOST` is not loopback. Token for `/admin/*` endpoints. |
| `CLI_PROXY_API_URL` | `http://localhost:8317` | Upstream CLIProxyAPI URL (required unless `PROXY_LOCAL_OK=1`) |
| `CLI_PROXY_API_KEY` | `proxy` | Proxy auth key sent to CLIProxyAPI |
| `CLAUDE_CODE_VERSION` | `2.1.87` | Claude Code version for bypass headers |
| `DB_PATH` | `data/proxy.db` | SQLite database path |
| `PRICING_CACHE_PATH` | `data/pricing-cache.json` | Runtime models.dev pricing cache |
| `READY_PRICING_MAX_AGE_MS` | `86400000` | Maximum pricing cache age accepted by `/ready` (24h) |
| `PRICING_REFRESH_INTERVAL_MS` | `21600000` | How often to refresh pricing from models.dev (6h) |
| `COST_BACKFILL_INTERVAL_MS` | `1800000` | How often to backfill zero-cost request logs (30m) |
| `COST_BACKFILL_LOOKBACK_MS` | `604800000` | How far back cost backfill looks (7d) |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Total upstream request timeout (5m) |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `10000` | Upstream connection timeout (10s) |
| `UPSTREAM_MAX_RETRIES` | `2` | Retry attempts for retryable idempotent upstream failures |
| `UPSTREAM_CIRCUIT_BREAKER_OPEN_AFTER_FAILURES` | `5` | Consecutive upstream failures before a provider circuit opens |
| `UPSTREAM_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS` | `30000` | Recovery window before one half-open probe is allowed |
| `UPSTREAM_CIRCUIT_BREAKER_EVICT_AFTER_MS` | `300000` | Inactive closed provider breaker retention window |
| `MAX_REQUEST_BODY_BYTES` | `25000000` | Maximum request body size accepted for proxied POST requests (25MB) |
| `STALE_PENDING_MAX_AGE_MS` | `300000` | Age at which pending request rows are recovered on boot (5m) |
| `QUOTA_REFRESH_INTERVAL_MS` | `300000` | How often to refresh CLIProxyAPI quota snapshots (5m) |
| `QUOTA_REFRESH_TIMEOUT_MS` | `15000` | Timeout for provider quota refresh calls (15s) |
| `CLIENT_NAME_MAPPING` | | API key to display name mapping (e.g. `key1=alice,key2=bob`) |
| `PROVIDERS_CONFIG_PATH` | | Optional JSON file for custom providers |
| `PROVIDERS_JSON` | | Inline custom provider JSON; takes precedence over `PROVIDERS_CONFIG_PATH` |
| `PLANS_JSON` | | Inline plans JSON; takes precedence over `PLANS_PATH` |
| `PLANS_PATH` | | Path to a custom plans.json file |
| `CLIPROXY_MGMT_KEY` | | Optional CLIProxyAPI management key for account correlation |
| `CLIPROXY_AUTH_DIR` | | Optional CLIProxyAPI auth directory for subscription quota checks |

## Custom Providers

Add OpenAI-compatible local or custom providers with JSON config. Select them per request using `x-provider: <id>` or a request body `provider` field; the proxy strips the body `provider` field before forwarding by default.

```json
{
  "providers": [
    {
      "id": "local",
      "type": "openai-compatible",
      "paths": ["/v1/chat/completions"],
      "upstreamBaseUrl": "http://localhost:11434",
      "upstreamPath": "/v1/chat/completions",
      "models": ["llama", "qwen"],
      "auth": "none"
    },
    {
      "id": "glm",
      "type": "openai-compatible",
      "paths": ["/v1/chat/completions"],
      "upstreamBaseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "models": ["glm"],
      "auth": { "type": "bearer", "env": "GLM_API_KEY" }
    }
  ]
}
```

Provider fields: `id`, `type` (`openai-compatible` or `anthropic`), `paths`, `upstreamBaseUrl`, optional `upstreamPath`, `models`, `headers`, `auth` (`none`, `preserve`, `bearer`, `x-api-key`, or object with `env`/`value`/`header`), and `stripProviderField`.

Save this as a file and set `PROVIDERS_CONFIG_PATH`, or set `PROVIDERS_JSON` to the inline JSON string. Use `agent-cli-proxy providers init` to create a starter file at the default config path.

## Subscription Plans

Plans map CLIProxyAPI accounts to subscription tiers for cost monitoring. This is **monitoring-only** — no request enforcement or quota blocking happens.

### plans.json format

```json
{
  "plans": [
    {
      "code": "claude_pro",
      "display_name": "Anthropic Claude Pro",
      "monthly_price_usd": 20,
      "notes": "Conservative estimate — verify with vendor — last updated 2026-05"
    }
  ]
}
```

The proxy ships with a default `plans.json` covering common plans (Claude Pro/Max, ChatGPT Plus/Pro/Business, Kimi Pro, GLM Pro, local BYOK). Override with `PLANS_JSON` or `PLANS_PATH`.

### Plans CLI commands

| Command | Description |
|---------|-------------|
| `agent-cli-proxy plans show` | Show loaded plans (human-readable) |
| `agent-cli-proxy plans show --json` | Show loaded plans as JSON |
| `agent-cli-proxy plans list` | List all plan codes and prices |
| `agent-cli-proxy plans init` | Create a starter plans.json at the default config path |
| `agent-cli-proxy plans path` | Print the active plans.json path |
| `agent-cli-proxy plans bind <account> <code>` | Bind a CLIProxyAPI account to a plan code |
| `agent-cli-proxy plans unbind <account>` | Remove a plan binding for an account |

## CLI Reference

| Command | Description |
|---------|-------------|
| `agent-cli-proxy init` | Interactive config + DB setup |
| `agent-cli-proxy init --non-interactive ...` | Non-interactive install (CI-friendly) |
| `agent-cli-proxy db init` | Initialize or migrate the SQLite database |
| `agent-cli-proxy paths` | Print default install paths |
| `agent-cli-proxy doctor` | Validate config, DB, plans, providers, pricing, upstream |
| `agent-cli-proxy doctor --json` | Doctor output as JSON (for issue reports) |
| `agent-cli-proxy service install` | Install user daemon (systemd/launchd) |
| `agent-cli-proxy service start` | Start the daemon |
| `agent-cli-proxy service stop` | Stop the daemon |
| `agent-cli-proxy service restart` | Restart the daemon |
| `agent-cli-proxy service status` | Show daemon status |
| `agent-cli-proxy service logs` | Show daemon logs |
| `agent-cli-proxy service logs --follow` | Stream daemon logs |
| `agent-cli-proxy plans show` | Show loaded plans |
| `agent-cli-proxy plans list` | List plan codes |
| `agent-cli-proxy plans init` | Create starter plans.json |
| `agent-cli-proxy plans path` | Print active plans.json path |
| `agent-cli-proxy plans bind <account> <code>` | Bind account to plan |
| `agent-cli-proxy plans unbind <account>` | Remove account binding |
| `agent-cli-proxy providers show` | Show loaded provider config |
| `agent-cli-proxy providers path` | Print active providers config path |
| `agent-cli-proxy providers init` | Create starter providers.json |
| `agent-cli-proxy providers reload` | Reload provider config without restart |
| `agent-cli-proxy backfill-costs` | Recompute zero-cost request logs |
| `agent-cli-proxy backfill-costs --all` | Recompute all request logs |

Prefer `--admin-token-env` and `--cliproxy-mgmt-key-env` for non-interactive installs so secrets do not appear in shell history or process arguments.

## Admin Endpoints

All `/admin/*` endpoints require `ADMIN_API_KEY` when the proxy is not bound to loopback.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness probe (always 200 if process alive) |
| `GET` | `/ready` | Readiness probe (DB, pricing, upstream); 503 when failing |
| `GET` | `/metrics` | Prometheus-format metrics |
| `GET` | `/admin/usage/today` | Today's usage summary |
| `GET` | `/admin/usage/range?from=&to=` | Usage by date range |
| `GET` | `/admin/usage/models?day=` | Model breakdown for a day |
| `GET` | `/admin/usage/providers?day=` | Provider breakdown for a day |
| `GET` | `/admin/usage/accounts?day=` | Per-account usage for a day |
| `GET` | `/admin/usage/accounts/range?from=&to=` | Per-account usage over a range |
| `GET` | `/admin/usage/accounts/summary?from=&to=` | Account summary (7-day default) |
| `GET` | `/admin/stats` | Total statistics |
| `GET` | `/admin/logs` | Request logs (paginated) |
| `GET` | `/admin/logs?tool=openclaw` | Filter logs by tool |
| `GET` | `/admin/logs?client_id=openclaw-jongi` | Filter logs by instance |
| `GET` | `/admin/logs/:id` | Single request log by ID |
| `GET` | `/admin/quotas` | Latest stored quota snapshots |
| `GET` | `/admin/quotas?refresh=true` | Refresh and return quota snapshots |
| `GET` | `/admin/quotas/refresh` | Force refresh quota snapshots |
| `GET` | `/admin/plans` | List all plans |
| `GET` | `/admin/plans/cost-summary?month=YYYY-MM` | Monthly cost summary by account |
| `GET` | `/admin/plans/account/:account` | Plan binding and recent usage for an account |

## Health and Readiness

`/health` is a cheap liveness probe. It returns `200 {"status":"ok"}` as long as the process is alive, with no dependency checks.

`/ready` is a readiness probe that checks the database, pricing cache freshness, upstream CLIProxyAPI, and supervisor loop state. It returns `200` when all checks pass and `503` when any critical dependency is failing.

Sample `/ready` response:

```json
{
  "status": "pass",
  "checks": {
    "database": { "status": "pass", "responseTime": 3 },
    "pricing": { "status": "pass", "ageMs": 14400000 },
    "upstream": { "status": "pass", "responseTime": 42 },
    "supervisor": { "status": "pass", "loops": ["pricing-refresh", "cost-backfill"] }
  }
}
```

Results are cached for 3 seconds to protect dependencies from aggressive polling. The response includes `Cache-Control: no-store`.

## Observability

Logs are structured JSON written to stdout (`info`, `warn`, `debug`) and stderr (`error`). Set `LOG_FORMAT=pretty` for human-readable output during development.

Key event names:

| Event | Description |
|-------|-------------|
| `lifecycle.pre_logged` | Request row inserted before upstream call |
| `lifecycle.finalized` | Request row updated after upstream response |
| `lifecycle.aborted` | Request aborted before upstream response |
| `upstream.error` | Upstream call failed (with error details) |
| `cost.guard` | Cost computation skipped or guarded |
| `plans.unmapped` | CLIProxyAPI account has no plan binding |
| `shutdown.drain` | Graceful shutdown draining in-flight requests |
| `shutdown.complete` | Shutdown finalized cleanly |

## Architecture

```
OpenCode  ─┐
OpenClaw  ─┤── agent-cli-proxy (3100) ── CLIProxyAPI (8317) ── Upstream APIs
Hermes    ─┘
```

Each tool is automatically identified by request headers and tracked separately. Multiple instances of the same tool are distinguished by `X-Agent-Name` header or session IDs.

The request lifecycle: a `pending` row is inserted before the upstream call (pre-log), the upstream response streams to the client, and the row is finalized with tokens and cost after the stream completes. An optional correlator loop maps CLIProxyAPI accounts to request rows for subscription attribution. A cost backfill loop recomputes zero-cost rows when pricing data becomes available.

### Tool Identification

| Tool | Detected By |
|------|------------|
| OpenCode | `x-opencode-session`, `x-initiator`, or `User-Agent: opencode/*` |
| OpenClaw | `x-openclaw-session-id`, `originator: openclaw`, or `X-Agent-Name` |
| Hermes | `User-Agent: HermesAgent/*` or `x-activity-request-id` |

### Project Structure

```
src/
├── config/           # Environment configuration and validation
├── identification/   # Plugin-based tool identification
├── provider/
│   ├── anthropic/    # Claude bypass + request transform
│   └── openai/       # OpenAI pass-through
├── server/           # HTTP handler, stream relay, usage logging
├── storage/          # SQLite repos, pricing, usage service
├── usage/            # Usage type definitions
└── admin/            # Admin API routes
```

## Troubleshooting

Run `agent-cli-proxy doctor` first. It validates configuration, opens the SQLite database, reports applied migrations, checks plans/providers configuration, inspects the pricing cache, probes `CLI_PROXY_API_URL/health`, and lists supervised loops. Use `--json` when attaching output to issues.

For daemon logs:

```bash
agent-cli-proxy service logs --follow
```

On Linux this proxies to `journalctl --user -u agent-cli-proxy.service -f`; on macOS it proxies to `log stream` for the `agent-cli-proxy` process.

**Common errors:**

- `CLI_PROXY_API_URL is required` — set `CLI_PROXY_API_URL` in your `.env` or pass `PROXY_LOCAL_OK=1` to allow the local default.
- `ADMIN_API_KEY is required when PROXY_HOST is not loopback` — set `ADMIN_API_KEY` before exposing the proxy beyond `127.0.0.1`.
- Plans fallback warning in logs — `plans.json` failed to parse; the proxy fell back to bundled defaults. Run `agent-cli-proxy plans show` to inspect the active config.

## Releasing

For maintainers: run `bun run release-check` to verify the build and package contents before tagging. Push a `v*` tag and the `.github/workflows/release.yml` GitHub Actions workflow runs `bun publish --access public --tolerate-republish` against the npm registry using the `NPM_TOKEN` repository secret.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
