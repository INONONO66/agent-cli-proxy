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
cp .env.example .env   # edit with your settings
bun run src/index.ts
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `3100` | Proxy server port |
| `CLI_PROXY_API_URL` | `http://localhost:8317` | Upstream API URL |
| `CLAUDE_CODE_VERSION` | `2.1.87` | Claude Code version for bypass headers |
| `DB_PATH` | `data/proxy.db` | SQLite database path |
| `CLIENT_NAME_MAPPING` | | API key to name mapping (e.g. `key1=alice,key2=bob`) |

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
