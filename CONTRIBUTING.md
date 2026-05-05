# Contributing to agent-cli-proxy

Thanks for your interest in contributing. This guide covers everything you need to get from zero to a working pull request.

## Local dev setup

```bash
git clone https://github.com/<owner>/agent-cli-proxy.git
cd agent-cli-proxy
bun install
```

Start the proxy in dev mode (hot reload):

```bash
bun run dev
```

Run the CLI directly from source:

```bash
bun run src/cli.ts init
bun run src/cli.ts doctor
```

Build the distributable bundle:

```bash
bun run build
```

## Running tests

```bash
bun test
```

Unit tests live in `tests/unit/`. End-to-end tests live in `tests/e2e/`. Run a specific file:

```bash
bun test tests/unit/config.test.ts
bun test tests/e2e/proxy.test.ts
```

Tests use Bun's built-in test runner (`bun:test`). No Jest, no Vitest. Add tests for any new functionality before submitting a PR.

## Code style

- **TypeScript strict mode** throughout. No `as any` casts. If you need to escape the type system, leave a comment explaining why.
- **Namespaces over classes** for module-level grouping (see `Config`, `Admin`, `Plans`, `Storage`). Follow the existing pattern.
- **No raw `console.log`** in `src/`. Use the structured logger: `Logger.fromConfig().child({ component: "your-module" })`.
- **Bun APIs** over Node.js equivalents where available: `Bun.file`, `Bun.serve`, `Bun.$`, `bun:sqlite`.
- Keep functions small and focused. If a function needs a long comment to explain what it does, consider splitting it.
- Prefer explicit over implicit. Named exports, explicit return types on public functions, no magic numbers without a named constant.

## Branching

Branch off `main` for all changes:

```bash
git checkout -b feat/my-feature
git checkout -b fix/the-bug
```

Use conventional commit messages:

```
feat(plans): add cost-summary endpoint
fix(upstream): handle connection timeout correctly
refactor(config): extract URL normalization helper
docs(readme): add quickstart section
test(admin): cover 404 path for unknown account
chore(deps): update bun lockfile
```

The scope (in parentheses) is optional but helpful for larger codebases. Keep the subject line under 72 characters.

## Pull request flow

1. Fork the repository and create your branch from `main`.
2. Make your changes. Add or update tests.
3. Run `bun test` and confirm everything passes.
4. Run `bun run build` and confirm the build succeeds.
5. Push your branch and open a pull request against `main`.
6. Fill in the PR description: what changed, why, and how to test it.
7. A maintainer will review and may request changes. Address feedback in new commits (don't force-push during review).

Keep PRs focused. A PR that fixes a bug and adds an unrelated feature is harder to review and harder to revert if something goes wrong. Split them.

## Architecture overview

The proxy intercepts HTTP requests from AI coding tools (OpenCode, OpenClaw, Hermes), identifies the originating tool from request headers, and forwards the request to CLIProxyAPI. Before forwarding, it inserts a `pending` row in SQLite. After the upstream response streams to the client, it finalizes the row with token counts and cost data from models.dev pricing. An optional correlator loop maps CLIProxyAPI accounts to request rows for subscription attribution. A cost backfill loop recomputes zero-cost rows when pricing data becomes available later.

Key modules:

- `src/config/` — environment validation and typed config singleton
- `src/identification/` — plugin-based tool detection from request headers
- `src/provider/` — Anthropic and OpenAI request transforms, custom provider registry
- `src/server/` — HTTP handler, stream relay, request lifecycle
- `src/storage/` — SQLite repos, pricing cache, usage service
- `src/admin/` — admin API routes (usage, plans, quotas, logs)
- `src/plans/` — subscription plan loading and account binding
- `src/upstream/` — resilient upstream client with circuit breaker and retry
- `src/runtime/` — supervisor for background loops (pricing refresh, cost backfill, quota refresh)
- `src/cli.ts` — all CLI commands (init, doctor, service, plans, providers, backfill-costs)

## Reporting issues

Use the [GitHub issue tracker](https://github.com/<owner>/agent-cli-proxy/issues). Include:

- A clear description of the problem
- Steps to reproduce
- Expected vs. actual behavior
- Output of `agent-cli-proxy doctor --json` if relevant
- Your OS, Bun version (`bun --version`), and proxy version

For security vulnerabilities, see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
