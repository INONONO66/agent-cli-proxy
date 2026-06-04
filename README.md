# agent-cli-proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/agent-cli-proxy.svg)](https://www.npmjs.com/package/agent-cli-proxy)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)

AI API proxy with per-tool usage monitoring. Sits between AI coding tools (OpenCode, OpenClaw, Hermes) and upstream API providers, tracking usage per tool and per instance, computing token costs from live pricing data, and correlating CLIProxyAPI accounts for cost attribution. Runs as a native Bun process. Self-hosted, no containers needed.

## Why this exists

Most AI coding tools share a single upstream API key, making it impossible to know which tool or session is responsible for a given cost spike. agent-cli-proxy forwards API requests, identifies the originating tool from request headers, and records LLM generation usage with accurate cost attribution from live pricing data. It also correlates CLIProxyAPI accounts to request rows so usage can be audited by upstream account.

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

Requires Bun 1.3.0 or newer.

```bash
git clone https://github.com/INONONO66/agent-cli-proxy.git
cd agent-cli-proxy
bun install
bun run build
bun run src/cli.ts init
```

### Server install from GitHub Release

Install or update a server directly from the latest GitHub Release asset:

```bash
curl -fsSL https://raw.githubusercontent.com/INONONO66/agent-cli-proxy/main/scripts/install-release.sh | bash
```

Install a specific version and register the user service in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/INONONO66/agent-cli-proxy/main/scripts/install-release.sh | \
  AGENT_CLI_PROXY_VERSION=v0.2.1 \
  AGENT_CLI_PROXY_SERVICE=1 \
  AGENT_CLI_PROXY_INIT=1 \
  AGENT_CLI_PROXY_ENV=$HOME/.config/agent-cli-proxy/.env \
  CLI_PROXY_API_URL=http://localhost:8317 \
  bash
```

The script requires Bun, downloads `agent-cli-proxy.tar.gz` from GitHub Releases,
installs the runtime under `~/.local/share/agent-cli-proxy/runtime`, and writes a
`~/.local/bin/agent-cli-proxy` wrapper. Set `AGENT_CLI_PROXY_INIT=1` to run
non-interactive initialization during install. Release tarball installs require
`v0.2.1` or newer because earlier tags do not include runtime assets.

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

- Local admin session login (`DASHBOARD_PASSWORD_HASH`)
- Admin API token (`ADMIN_API_KEY`) for local admin endpoints
- CLIProxyAPI account correlation (`CLIPROXY_MGMT_KEY`)
- SQLite/pricing cache paths

Provider API keys are intentionally **not** stored by this proxy. The proxy routes through CLIProxyAPI; configure provider credentials there.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `3100` | Proxy server port |
| `PROXY_HOST` | `127.0.0.1` | Bind host. Keep loopback unless you add auth/network controls. |
| `TRUST_PROXY_HEADERS` | `false` | Trust reverse-proxy headers such as `X-Forwarded-Proto`/Cloudflare visitor scheme for HTTPS-only decisions. Enable only behind a trusted proxy. |
| `ADMIN_API_KEY` | | Optional token for local-only `/admin/*` and `/metrics` endpoints. |
| `PROXY_REQUIRE_API_KEY` | `false` on loopback, `true` off loopback | Require a valid managed proxy key on `/v1/*` and `/api/*` requests, sent as either `Authorization: Bearer <proxy-key>` or `x-api-key: <proxy-key>`. Keep enabled for any externally reachable deployment. |
| `CLI_PROXY_API_URL` | `http://localhost:8317` | Upstream CLIProxyAPI URL (required unless `PROXY_LOCAL_OK=1`) |
| `CLI_PROXY_API_KEY` | `proxy` | Proxy auth key sent to CLIProxyAPI |
| `CLAUDE_CODE_VERSION` | `2.1.87` | Claude Code version for bypass headers |
| `DB_PATH` | `$XDG_DATA_HOME/agent-cli-proxy/proxy.db` or `~/.local/share/agent-cli-proxy/proxy.db` | SQLite database path. Use an absolute path outside repo/dist/runtime replacement directories. |
| `PRICING_CACHE_PATH` | `$XDG_DATA_HOME/agent-cli-proxy/pricing-cache.json` or `~/.local/share/agent-cli-proxy/pricing-cache.json` | Runtime models.dev pricing cache. Use an absolute path outside repo/dist/runtime replacement directories. |
| `READY_PRICING_MAX_AGE_MS` | `86400000` | Maximum pricing cache age accepted by `/ready` (24h) |
| `PRICING_REFRESH_INTERVAL_MS` | `21600000` | How often to refresh pricing from models.dev (6h) |
| `PRICING_OVERRIDES_JSON` | built-in overrides | Optional JSON object of model pricing overrides, keyed by model name. Values use models.dev-style `input`, `output`, `cache_read`, `cache_write`, and `reasoning` per-million-token prices. |
| `PRICING_ALIASES_JSON` | built-in aliases | Optional JSON object mapping model prefixes to pricing model names for local alias resolution. |
| `COST_BACKFILL_INTERVAL_MS` | `1800000` | How often to backfill zero-cost request logs (30m) |
| `COST_BACKFILL_LOOKBACK_MS` | `604800000` | How far back cost backfill looks (7d) |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Total upstream request timeout (5m) |
| `UPSTREAM_STREAM_FIRST_BYTE_TIMEOUT_MS` | `900000` | First SSE chunk timeout for Claude `/v1/messages` streaming requests (15m). Use this to tolerate slow Claude queueing without relaxing non-streaming requests. |
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
| `CLIPROXY_MGMT_KEY` | | Optional CLIProxyAPI management key for account correlation |
| `CLIPROXY_AUTH_DIR` | | Optional CLIProxyAPI auth directory for quota probes |
| `UPSTREAM_CIRCUIT_BREAKER_OPEN_AFTER_FAILURES` | `5` | Consecutive upstream failures before the circuit breaker opens |
| `UPSTREAM_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS` | `30000` | Delay before a half-open probe is allowed (30s) |
| `UPSTREAM_CIRCUIT_BREAKER_EVICT_AFTER_MS` | `300000` | Idle time before a healthy breaker is evicted (5m) |

### Persistent config and data paths

Keep mutable files outside the deploy directory so `git pull`, rsync, package
replacement, or runtime bundle refreshes do not erase state:

- config/env: `~/.config/agent-cli-proxy/.env` for user installs, or
  `/etc/agent-cli-proxy/agent-cli-proxy.env` for system installs
- SQLite DB and WAL/SHM: `~/.local/share/agent-cli-proxy/proxy.db` or
  `/var/lib/agent-cli-proxy/proxy.db`
- pricing cache: `~/.local/share/agent-cli-proxy/pricing-cache.json` or
  `/var/cache/agent-cli-proxy/pricing-cache.json`

`agent-cli-proxy init` writes absolute `DB_PATH` and `PRICING_CACHE_PATH`
values. Runtime defaults also use XDG data paths when those variables are
unset. Explicit relative paths still work for local development, but startup
emits configuration warnings because they are deploy-directory dependent.



### Public proxy API keys

When the proxy binds to a non-loopback host, `PROXY_REQUIRE_API_KEY` defaults to
`true`. In that mode, every LLM proxy request under `/v1/*` and `/api/*` must
include a valid managed proxy key as either `Authorization: Bearer <proxy-key>`
or `x-api-key: <proxy-key>` (Anthropic-SDK style). `Authorization` takes
precedence when both are present. The legacy `x-proxy-key` header still does
not satisfy this application-level check. Non-loopback binds cannot disable
this requirement; keep `PROXY_HOST` on loopback for local development without
proxy client keys.

Create and manage client proxy keys from the local-only `/admin/api-keys` API.
These keys remain separate from `ADMIN_API_KEY` and from the upstream
`CLI_PROXY_API_KEY`.

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

Provider fields: `id`, `type` (`openai-compatible` or `anthropic`), `paths`, `upstreamBaseUrl`, optional `upstreamPath`, `models`, `headers`, `auth` (`none`, `preserve`, `bearer`, `x-api-key`, or object with `env`/`value`/`header`), and `stripProviderField`. Requests selected with `x-provider` or a JSON `provider` field are routed to the configured `upstreamBaseUrl` and `upstreamPath`; `stripProviderField: true` removes the selector before forwarding. Anthropic providers default `anthropic-version` to `2023-06-01` when the client omits it.

Save this as a file and set `PROVIDERS_CONFIG_PATH`, or set `PROVIDERS_JSON` to the inline JSON string. Use `agent-cli-proxy providers init` to create a starter file at the default config path.

## CLI Reference

| Command | Description |
|---------|-------------|
| `agent-cli-proxy init` | Interactive config + DB setup |
| `agent-cli-proxy init --non-interactive ...` | Non-interactive install (CI-friendly) |
| `agent-cli-proxy db init` | Initialize or migrate the SQLite database |
| `agent-cli-proxy paths` | Print default install paths |
| `agent-cli-proxy doctor` | Validate config, DB, providers, pricing, upstream |
| `agent-cli-proxy doctor --json` | Doctor output as JSON (for issue reports) |
| `agent-cli-proxy service install` | Install user daemon (systemd/launchd) |
| `agent-cli-proxy service start` | Start the daemon |
| `agent-cli-proxy service stop` | Stop the daemon |
| `agent-cli-proxy service restart` | Restart the daemon |
| `agent-cli-proxy service status` | Show daemon status |
| `agent-cli-proxy service logs` | Show daemon logs |
| `agent-cli-proxy service logs --follow` | Stream daemon logs |
| `agent-cli-proxy providers show` | Show loaded provider config |
| `agent-cli-proxy providers path` | Print active providers config path |
| `agent-cli-proxy providers init` | Create starter providers.json |
| `agent-cli-proxy providers reload` | Reload provider config without restart |
| `agent-cli-proxy backfill-costs` | Recompute zero-cost request logs |
| `agent-cli-proxy backfill-costs --all` | Recompute all request logs |

Prefer `--admin-token-env` and `--cliproxy-mgmt-key-env` for non-interactive installs so secrets do not appear in shell history or process arguments.

## Admin Endpoints

`/admin/*` and `/metrics` are only available to loopback clients
(`127.0.0.1`, `::1`). When `ADMIN_API_KEY` is set, local callers must send
`x-admin-token: $ADMIN_API_KEY` or `Authorization: Bearer $ADMIN_API_KEY`.
The proxy no longer serves a bundled dashboard; build a dashboard as a separate
client that talks to these local admin APIs.

Usage day parameters and defaults are UTC dates.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness probe (always 200 if process alive) |
| `GET` | `/ready` | Readiness probe (DB, pricing, upstream); 503 when failing |
| `GET` | `/metrics` | Prometheus-format metrics, including usage counters and low-cardinality latency histograms |
| `GET` | `/admin/usage/today` | Current UTC day usage summary |
| `GET` | `/admin/usage/range?from=&to=` | Usage by date range |
| `GET` | `/admin/usage/models?day=` | Model breakdown for a day |
| `GET` | `/admin/usage/providers?day=` | Provider breakdown for a day |
| `GET` | `/admin/usage/accounts?day=` | Per-account usage for a day |
| `GET` | `/admin/usage/accounts/range?from=&to=` | Per-account usage over a range |
| `GET` | `/admin/usage/accounts/summary?from=&to=` | Account summary (7-day default) |
| `GET` | `/admin/usage/trend?hours=` | Time-bucketed usage trend |
| `GET` | `/admin/stats` | Total statistics |
| `GET` | `/admin/logs` | Request logs (paginated) |
| `GET` | `/admin/logs?tool=openclaw` | Filter logs by tool |
| `GET` | `/admin/logs?client_id=openclaw-jongi` | Filter logs by instance |
| `GET` | `/admin/logs/:id` | Single request log by ID |
| `GET` | `/admin/logs/:id/cost-audit` | Cost audit records for a request log |
| `GET` | `/admin/quotas` | Latest stored quota snapshots |
| `GET` | `/admin/quotas?refresh=true` | Refresh and return quota snapshots |
| `GET` | `/admin/quotas/refresh` | Force refresh quota snapshots |
| `GET` | `/admin/quotas/probes` | Available quota probe definitions |
| `GET` | `/admin/quotas/history?hours=` | Time-bucketed quota snapshots |
| `GET` | `/admin/providers` | Loaded provider definitions and source info |
| `GET` | `/admin/pricing?model=&provider=` | Pricing match and cache freshness for a model |
| `GET` | `/admin/config` | Redacted runtime configuration summary |
| `GET` | `/admin/api-keys` | List managed proxy API keys |
| `POST` | `/admin/api-keys` | Create a managed proxy API key |
| `GET` | `/admin/breakers` | List all circuit breaker states |
| `GET` | `/admin/breakers/:providerId` | Single breaker state by provider |
| `POST` | `/admin/breakers/:providerId/reset` | Reset a breaker to closed state |



## Health and Readiness

`/health` is a cheap liveness probe. It returns `200 {"status":"ok"}` as long as the process is alive, with no dependency checks.

`/ready` is a readiness probe that checks the database, pricing cache freshness, upstream CLIProxyAPI, and supervisor loop state. It returns `200` when all checks pass or only transient supervisor retries are in progress, and `503` when any critical dependency is failing.

Sample `/ready` response:

```json
{
  "status": "pass",
  "checks": {
    "database": { "status": "pass", "responseTime": 3 },
    "pricing": { "status": "pass", "ageMs": 14400000 },
    "upstream": { "status": "pass", "responseTime": 42 },
    "supervisor": {
      "status": "warn",
      "loops": ["pricing-refresh", "cost-backfill"],
      "loopHealth": [
        {
          "name": "pricing-refresh",
          "consecutiveFailures": 1,
          "status": "warn",
          "lastErrorAgeMs": 2500
        },
        {
          "name": "cost-backfill",
          "consecutiveFailures": 0,
          "status": "pass",
          "lastSuccessAgeMs": 60000
        }
      ]
    }
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
| `passthrough.upstream_headers` | Upstream response headers arrived; includes latency and status for pre-body diagnosis |
| `passthrough.stream_first_chunk` | First upstream SSE chunk arrived; includes latency for diagnosing Claude queueing |
| `upstream.error` | Upstream call failed (timeout, 5xx, network) |
| `upstream.breaker_reject` | Request rejected by open circuit breaker (not an upstream failure) |
| `upstream.breaker_reset` | Circuit breaker manually reset via admin endpoint |
| `cost.guard` | Cost computation skipped or guarded |
| `shutdown.drain` | Graceful shutdown draining in-flight requests |
| `shutdown.complete` | Shutdown finalized cleanly |

## Architecture

```
OpenCode  ─┐
OpenClaw  ─┤── agent-cli-proxy (3100) ── CLIProxyAPI (8317) ── Upstream APIs
Hermes    ─┘
```

Each tool is automatically identified by request headers and tracked separately. Multiple instances of the same tool are distinguished by `X-Agent-Name` header or session IDs.

The request lifecycle for LLM generation calls: a `pending` row is inserted before the upstream call (pre-log), the upstream response streams to the client, and the row is finalized with tokens and cost after the stream completes. Non-LLM proxy calls are forwarded without request-log rows. ProviderTransform modules apply provider-specific header, body, response, and stream-line rewrites, while the provider registry selects built-in or custom providers. An optional correlator loop maps CLIProxyAPI accounts to request rows for account attribution. A cost backfill loop recomputes zero-cost rows when pricing data becomes available.

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
├── provider/
│   ├── anthropic/    # Anthropic request/response helpers
│   ├── transforms/   # ProviderTransform registrations
│   └── registry.ts   # Built-in and custom provider routing
├── server/           # HTTP handler, stream relay, usage logging
├── storage/          # SQLite repos, pricing, usage service
├── usage/            # Usage type definitions
└── admin/            # Admin API routes
```

## Troubleshooting

Run `agent-cli-proxy doctor` first. It validates configuration, opens the SQLite database, reports applied migrations, checks provider configuration, inspects the pricing cache, probes `CLI_PROXY_API_URL/health`, and lists supervised loops. Use `--json` when attaching output to issues.

For daemon logs:

```bash
agent-cli-proxy service logs --follow
```

On Linux this proxies to `journalctl --user -u agent-cli-proxy.service -f`; on macOS it proxies to `log stream` for the `agent-cli-proxy` process.

**Common errors:**

- `CLI_PROXY_API_URL is required` — set `CLI_PROXY_API_URL` in your `.env` or pass `PROXY_LOCAL_OK=1` to allow the local default.
- `PROXY_REQUIRE_API_KEY must be true when PROXY_HOST is not loopback` — public proxy binds require a managed proxy key (`Authorization: Bearer <proxy-key>` or `x-api-key: <proxy-key>`) for `/v1/*` and `/api/*` requests.

## Releasing

For maintainers: run `bun run release-check` to verify the build and package contents before tagging. Push a `v*` tag and the `.github/workflows/release.yml` GitHub Actions workflow runs `bun publish --access public --tolerate-republish` against the npm registry using the `NPM_TOKEN` repository secret, then creates a GitHub Release with `agent-cli-proxy.tar.gz` runtime assets for server installs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
