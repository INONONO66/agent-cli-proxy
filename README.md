# agent-cli-proxy

Generic AI API proxy with usage monitoring. Sits between AI coding tools and CLIProxyAPI.

## Architecture

```
Client (opencode, aider) → agent-cli-proxy (port 3100) → CLIProxyAPI (port 8317) → Upstream APIs
```

## Quick Start

### Local

```bash
bun install
bun run dev
```

### Docker

```bash
docker-compose up -d
```

## Configuration

Copy `.env.example` to `.env` and adjust:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `3100` | Proxy server port |
| `CLI_PROXY_API_URL` | `http://localhost:8317` | CLIProxyAPI URL |
| `CLAUDE_CODE_VERSION` | `2.1.87` | Claude Code version for bypass |
| `DB_PATH` | `data/proxy.db` | SQLite database path |

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Anthropic Messages API (with Claude bypass) |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (pass-through) |
| `GET` | `/health` | Health check |
| `GET` | `/admin/usage/today` | Today's usage |
| `GET` | `/admin/stats` | Total statistics |
| `GET` | `/admin/logs` | Request logs |

## Testing

```bash
bun test                    # Unit tests
bun run test:e2e:mock       # E2E tests (mock mode, no CLIProxyAPI needed)
```
