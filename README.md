# agent-cli-proxy

AI API proxy with per-tool usage monitoring. Sits between AI coding tools and upstream API providers, tracking usage per tool and per instance.

## Architecture

```
OpenCode  ─┐
OpenClaw  ─┤── agent-cli-proxy (3100) ── CLIProxyAPI (8317) ── Upstream APIs
Hermes    ─┘
```

Each tool is automatically identified by request headers and tracked separately.

## Quick Start

```bash
bun install
bun run build
bun run src/cli.ts init
bun run src/cli.ts service start
```

For published/package installs, the same flow is exposed as a CLI:

```bash
bunx agent-cli-proxy init
agent-cli-proxy service install
agent-cli-proxy service start
```

The installer creates OS-appropriate local paths by default:

| Purpose | Default |
|---------|---------|
| Config | `~/.config/agent-cli-proxy/.env` |
| Data / SQLite | `~/.local/share/agent-cli-proxy/proxy.db` |
| Runtime bundle | `~/.local/share/agent-cli-proxy/runtime` |
| Linux daemon | `~/.config/systemd/user/agent-cli-proxy.service` |
| macOS daemon | `~/Library/LaunchAgents/ai.agent-cli-proxy.plist` |

`agent-cli-proxy init` asks which optional features to enable and writes only the needed settings:

- dashboard login (`DASHBOARD_PASSWORD_HASH`)
- admin API token (`ADMIN_API_KEY`) when exposing beyond loopback
- CLIProxyAPI account correlation (`CLIPROXY_MGMT_KEY`)
- SQLite/pricing cache paths

Provider API keys are intentionally **not** stored by this proxy unless CLIProxyAPI exposes a supported registration API. The proxy routes through CLIProxyAPI; provider credentials should be configured in CLIProxyAPI. Direct-provider fallback can be added later once the registration contract is explicit.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `3100` | Proxy server port |
| `PROXY_HOST` | `127.0.0.1` | Bind host. Keep loopback unless you add auth/network controls. |
| `ADMIN_API_KEY` | | Optional token for `/admin/*` when not loopback-only. |
| `CLI_PROXY_API_URL` | `http://localhost:8317` | Upstream API URL |
| `CLI_PROXY_API_KEY` | `proxy` | Proxy auth key sent to CLIProxyAPI |
| `CLAUDE_CODE_VERSION` | `2.1.87` | Claude Code version for bypass headers |
| `DB_PATH` | `data/proxy.db` | SQLite database path |
| `PRICING_CACHE_PATH` | `data/pricing-cache.json` | Runtime models.dev pricing cache |
| `CLIENT_NAME_MAPPING` | | API key to name mapping (e.g. `key1=alice,key2=bob`) |
| `PROVIDERS_CONFIG_PATH` | | Optional JSON file for custom providers |
| `PROVIDERS_JSON` | | Inline custom provider JSON; takes precedence over `PROVIDERS_CONFIG_PATH` |
| `CLIPROXY_MGMT_KEY` | | Optional CLIProxyAPI management key for account correlation |
| `CLIPROXY_AUTH_DIR` | | Optional CLIProxyAPI auth directory for subscription quota checks (`~/.cli-proxy-api`) |
| `QUOTA_REFRESH_TIMEOUT_MS` | `15000` | Timeout for provider quota refresh calls |

## CLI

```bash
agent-cli-proxy init                         # interactive config + DB setup
agent-cli-proxy db init --env ~/.config/agent-cli-proxy/.env
agent-cli-proxy service install              # install user daemon
agent-cli-proxy service start|stop|restart|status
agent-cli-proxy backfill-costs               # recompute zero-cost request logs
agent-cli-proxy backfill-costs --all         # recompute all request logs
agent-cli-proxy paths                        # print default install paths
```

The CLI avoids shell installer files for normal use. It generates systemd user services on Linux and launchd agents on macOS.

## Production install from source

```bash
git clone https://github.com/<owner>/agent-cli-proxy.git
cd agent-cli-proxy
bun install
bun run build
bun run src/cli.ts init
bun run src/cli.ts service install
systemctl --user enable --now agent-cli-proxy  # Linux
```

The runtime bundle is copied out of the repository, so the daemon does not need the source tree after install.

## Maintenance

```bash
agent-cli-proxy backfill-costs --all
curl http://127.0.0.1:3100/health
```

## Tool Identification

Tools are identified automatically by request headers:

| Tool | Detected By |
|------|------------|
| OpenCode | `x-opencode-session`, `x-initiator`, or `User-Agent: opencode/*` |
| OpenClaw | `x-openclaw-session-id`, `originator: openclaw`, or `X-Agent-Name` |
| Hermes | `User-Agent: HermesAgent/*` or `x-activity-request-id` |

Multiple instances of the same tool are distinguished by `X-Agent-Name` header or session IDs.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (with Claude bypass) |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (pass-through) |
| `GET` | `/health` | Health check |

### Admin API (localhost only)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/usage/today` | Today's usage summary |
| `GET` | `/admin/usage/range?from=&to=` | Usage by date range |
| `GET` | `/admin/stats` | Total statistics |
| `GET` | `/admin/logs` | Request logs |
| `GET` | `/admin/logs?tool=openclaw` | Filter by tool |
| `GET` | `/admin/logs?client_id=openclaw-jongi` | Filter by instance |
| `GET` | `/admin/quotas` | Return latest stored quota snapshots without provider calls |
| `GET` | `/admin/quotas?refresh=true` | Refresh and report subscription quota windows for configured CLIProxyAPI auth files |
| `GET` | `/admin/quotas/refresh` | Force refresh subscription quota snapshots |

Quota checks use local CLIProxyAPI OAuth auth files when `CLIPROXY_AUTH_DIR` is set. Claude reports 5-hour and weekly utilization from Anthropic OAuth usage, Codex reports primary/secondary windows from ChatGPT `wham/usage`, and Kimi reports coding weekly/5-hour quota when its usage endpoint accepts the stored token.

### Custom Providers

Add OpenAI-compatible local/custom providers with JSON config. Select them per request using `x-provider: <id>` or a request body `provider` field; the proxy strips the body `provider` field before forwarding by default.

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

## Project Structure

```
src/
├── config/           # Environment configuration
├── identification/   # Plugin-based tool identification
├── provider/
│   ├── anthropic/    # Claude bypass + request transform
│   └── openai/       # OpenAI pass-through
├── server/           # HTTP handler, stream relay, usage logging
├── storage/          # SQLite repos, pricing, usage service
├── usage/            # Usage type definitions
└── admin/            # Admin API routes
```

## Testing

```bash
bun test
```

## License

MIT
