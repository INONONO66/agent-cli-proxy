# HTTP Health/Readiness & Graceful Shutdown Research (May 2026)

## SOURCES CONSULTED

### Official Bun Documentation
- **Bun.serve API Reference**: https://bun.com/reference/bun/serve
  - `Server.stop(closeActiveConnections?: boolean): Promise<void>` - graceful shutdown
  - `Server.pendingRequests: number` - in-flight HTTP requests
  - `Server.pendingWebSockets: number` - active WebSocket connections
  - `Server.reload(options)` - hot reload without restart
  - No built-in AbortController timeout; must use external pattern

### Health Check Best Practices (2026)
- **Microsoft ASP.NET Core Health Checks**: https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/health-checks
- **StatusCodeFYI Health Check Guide**: https://protocolcodes.com/guides/health-check-endpoint-guide/
- **ASOasis REST API Health Design**: https://asoasis.tech/articles/2026-04-07-0253-rest-api-health-check-endpoint-design/
- **Layrs Microservices Health Patterns**: https://layrs.me/course/hld/12-reliability-patterns/health-endpoint-monitoring/
- **Spring Boot Actuator (Kubernetes reference)**: Microservices Health Checks & Graceful Shutdown 2026

### Real-World Bun Graceful Shutdown
- **claude-code gracefulShutdown.ts**: https://github.com/claude-code-best/claude-code/blob/main/src/utils/gracefulShutdown.ts
  - Workaround for Bun signal handler bug with process.removeListener
  - SIGTERM/SIGINT/SIGHUP handling pattern
  - Exit codes: 0 for SIGINT, 143 (128+15) for SIGTERM

---

## KEY FINDINGS

### 1. HEALTH ENDPOINT ARCHITECTURE

**Three Distinct Endpoints (Kubernetes-inspired, applies universally)**

| Endpoint | Purpose | Checks | Latency | Failure Action |
|----------|---------|--------|---------|-----------------|
| `/health/live` | Process alive? | Event loop responds, no deadlock | <50ms | Restart container |
| `/health/ready` | Ready for traffic? | DB, cache, upstream, config | <200ms | Remove from LB, no restart |
| `/health/startup` | Initialization done? | Migrations, cache warm | Seconds | Suppress early restarts |

**Key Principle**: Liveness must NOT check external dependencies. A database outage should drain traffic (readiness fail) but NOT restart the process.

### 2. READINESS CHECK SPECIFICS (for /ready endpoint)

**Required Checks** (all must pass for 200 OK):
- Database: `SELECT 1` + verify connection pool has `minimumIdle` connections
- Cache (Redis): PING with <100ms timeout
- Message broker: Open channel, publish/confirm noop
- Critical downstream HTTP: HEAD or GET on cheap endpoint
- Configuration/secrets: Presence check
- Migrations: State if mandatory for correctness

**Timeout Strategy**:
- Per-dependency timeout: 100–300ms each
- Global deadline: Cap total readiness at 1.5s (per plan: 1.5s cap)
- Return partial results with aggregate status (fail-safe)

**Caching**:
- Liveness: No cache, fully in-process
- Readiness: Memoize dependency results for 2–10 seconds with per-check TTLs
- HTTP headers: `Cache-Control: no-store` for external monitors

### 3. HTTP STATUS CODES & RESPONSE FORMAT

**Status Codes**:
- `200 OK` → `pass` or `warn` (degraded but functional)
- `503 Service Unavailable` → `fail` (critical dependency down)

**Response Format** (RFC draft-inadarei-api-health-check):
```json
{
  "status": "pass|warn|fail",
  "checks": {
    "database": [{"status": "pass", "responseTime": 12}],
    "cache": [{"status": "fail", "output": "connection timeout"}],
    "upstream": [{"status": "warn", "responseTime": 450}]
  }
}
```

### 4. GRACEFUL SHUTDOWN PATTERN (Bun-specific)

**Signal Handling** (from claude-code):
```typescript
// Workaround: Bun bug where process.removeListener resets kernel sigaction
// even when other JS listeners remain. Use memoized setup to avoid re-registration.

process.on('SIGINT', () => {
  logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
  void gracefulShutdown(0)
})

process.on('SIGTERM', () => {
  logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGTERM' })
  void gracefulShutdown(143) // Exit code 143 (128 + 15) for SIGTERM
})

process.on('SIGHUP', () => {
  logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGHUP' })
  void gracefulShutdown(129) // Exit code 129 (128 + 1) for SIGHUP
})
```

**Shutdown Sequence**:
1. Stop accepting new connections: `await server.stop(false)` (default: don't close active)
2. Drain in-flight requests: Poll `server.pendingRequests` until 0 or timeout
3. Drain WebSockets: Poll `server.pendingWebSockets` until 0 or timeout
4. Finalize pending rows: Commit/checkpoint WAL if using SQLite
5. Exit with appropriate code

**Timeout Bounds**:
- Kubernetes preStop hook: 10–15 seconds before SIGTERM
- Graceful drain: 5–10 seconds max
- Hard kill: After drain timeout, force close with `server.stop(true)`

### 5. ABORTCONTROLLER / TIMEOUT PATTERNS

**Bun stdlib does NOT provide AbortController.timeout()** (unlike Node.js 17+).

**Workaround for bounded readiness checks**:
```typescript
// Manual timeout using Promise.race
const timeoutPromise = new Promise((_, reject) =>
  setTimeout(() => reject(new Error('Readiness check timeout')), 1500)
)

const readinessCheck = Promise.all([
  checkDatabase(),
  checkCache(),
  checkUpstream()
])

try {
  await Promise.race([readinessCheck, timeoutPromise])
  return new Response(JSON.stringify({ status: 'pass' }), { status: 200 })
} catch (err) {
  return new Response(JSON.stringify({ status: 'fail', error: err.message }), { status: 503 })
}
```

**Alternative: AbortSignal with timeout (if Bun adds support)**:
```typescript
const controller = new AbortController()
const timeoutId = setTimeout(() => controller.abort(), 1500)

try {
  await Promise.all([
    checkDatabase({ signal: controller.signal }),
    checkCache({ signal: controller.signal })
  ])
} finally {
  clearTimeout(timeoutId)
}
```

### 6. LOAD BALANCER INTEGRATION

**Polling Configuration**:
- Interval: 5–10 seconds for readiness
- Timeout: 2 seconds (shorter than interval to prevent accumulation)
- Failure threshold: 3–5 consecutive failures before removal
- Success threshold: 1–2 successes for restoration

**Risk**: Overly aggressive health checks (1-second intervals) create "thundering herd" when dependencies fail—thousands of instances hammering a degraded database makes recovery impossible.

---

## GOTCHAS FOR BUN ON MACOS/LINUX

1. **Signal Handler Bug**: `process.removeListener(sig, fn)` resets kernel sigaction even when other listeners remain. Workaround: memoize signal setup, avoid re-registration.

2. **No AbortController.timeout()**: Must use `Promise.race` with `setTimeout` for bounded checks.

3. **Server.stop() semantics**: By default does NOT close in-flight requests/WebSockets. Must poll `pendingRequests`/`pendingWebSockets` and set a hard timeout.

4. **Hot reload**: `server.reload()` updates fetch/error handlers without restart, but only those two—port/hostname changes are ignored.

5. **Memory pre-allocation**: Bun pre-allocates ~500 KB per server for 2048 concurrent requests. Avoid frequent start/stop cycles.

6. **SQLite WAL checkpoint**: On shutdown, call `PRAGMA optimize` and `CHECKPOINT` to finalize pending rows before exit.

---

## RECOMMENDATIONS FOR THIS PROJECT

### /health (Liveness)
- **Endpoint**: `GET /health` or `GET /health/live`
- **Checks**: Event loop responds (implicit in HTTP 200)
- **Response**: `{ "status": "pass" }` with 200
- **Latency**: <50ms
- **Caching**: None

### /ready (Readiness)
- **Endpoint**: `GET /health/ready`
- **Checks**:
  - SQLite: `SELECT 1` + verify pool has connections
  - Upstream CLIProxyAPI: HEAD or GET on `/health/ready` (if available)
  - Pricing cache: File exists and is readable
  - Config: Required env vars present
- **Timeout**: 1.5s global (per plan)
- **Response**: `{ "status": "pass|warn|fail", "checks": {...} }` with 200 or 503
- **Caching**: 2–5 second memoization per check

### Graceful Shutdown
- **Signal handlers**: SIGTERM, SIGINT, SIGHUP (memoized setup)
- **Sequence**:
  1. `await server.stop(false)` (stop accepting, don't force-close)
  2. Poll `server.pendingRequests` for up to 5 seconds
  3. Finalize pending rows: `PRAGMA optimize; CHECKPOINT;`
  4. Exit with code 0 (SIGINT) or 143 (SIGTERM)
- **Hard timeout**: After 5s, call `server.stop(true)` to force close

### Supervisor Integration
- Supervisor should restart on non-zero exit
- Supervisor should send SIGTERM, wait 10s, then SIGKILL
- Health checks should be called every 10s by supervisor or LB

---

## REFERENCES

1. Bun.serve API: https://bun.com/reference/bun/serve
2. Health Check Design: https://protocolcodes.com/guides/health-check-endpoint-guide/
3. Kubernetes Probes: https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
4. RFC Health Check: https://datatracker.ietf.org/doc/html/draft-inadarei-api-health-check
5. Bun Graceful Shutdown (claude-code): https://github.com/claude-code-best/claude-code/blob/main/src/utils/gracefulShutdown.ts

---

# T9 Strict Cost Mode Learnings (May 2026)

- Centralizing pricing math in `Cost.compute()` prevents record/finalize/backfill paths from drifting; audit insertion should happen at the same transaction boundary as the request row mutation.
- Fallback local pricing after a failed first fetch must be immediately stale (`fetchedAt = 0`) so models.dev is retried on the next call instead of masking outages for the cache TTL.
- Fuzzy pricing lookup should never match by `known_key.includes(input_alias)`: short aliases such as `gpt-5` can incorrectly price future variants. Keeping only `input_alias.includes(known_key)` with a minimum key length avoids the dangerous direction.
- To preserve the application invariant needed by cost-summary consumers, `cost_status='ok'` should mean `cost_usd > 0`; zero-token usage stays pending/guarded rather than creating ok zero-cost rows.
- With the Supervisor module present, cost backfill should be registered as a supervised loop (`cost-backfill`) and share the shutdown `AbortSignal` instead of using a raw `setInterval`.

# T10 Subscription Attribution Learnings (May 2026)

- Keep plan metadata and enforcement separate: `account_subscriptions` only maps a CLIProxy account to a plan code, while request processing continues without quota/limit decisions.
- Attribution is safest immediately after account correlation, because pass-through pre-logs intentionally do not know the CLIProxy account yet.
- A dedicated `RequestRepo.applySubscription()` update avoids overloading lifecycle/finalize updates when only the monitoring metadata changes.
- CLI plan-code validation should call the same `Plans` loader used elsewhere so custom `PLANS_JSON`/`PLANS_PATH` configurations and packaged defaults stay consistent.
- Once-per-account/day warning dedup can remain in memory for this monitoring use case; keying by `${account}:${YYYY-MM-DD}` prevents noisy unmapped-account logs without database state.

# T12 Readiness Endpoint Learnings (May 2026)

- Keep `/health` as a dependency-free liveness probe; dependency failures belong in `/ready` so orchestrators drain traffic without restarting a healthy process.
- Use a unique upstream provider id (`ready-probe`) and no retries for readiness probes so monitoring cannot trip the main CLIProxyAPI circuit breaker or extend beyond the 1.5s budget.
- Pricing readiness needs both disk presence and in-memory freshness: the file proves persisted cache exists, while `Pricing.getPricingFreshness()` proves the runtime loaded a non-stale cache.
- A short global memoization window (3s) protects SQLite and upstream dependencies from aggressive polling while `Cache-Control: no-store` prevents external monitors from caching stale readiness.
- Supervisor readiness is best exposed as a cheap registry snapshot (`Supervisor.list()`), avoiding lifecycle mutations or stop/start behavior inside health-check paths.

# T13 Admin Plans Monitoring Learnings (May 2026)

- Keep plan monitoring read-only: route handlers can join `request_logs`, `account_subscriptions`, and `Plans.byCode()` data without feeding any enforcement path.
- Monthly summaries should filter `lifecycle_status='completed'` and use half-open UTC ranges (`start <= started_at < next_month`) to avoid double-counting boundary rows.
- Including unbound accounts in cost summaries makes attribution gaps visible; represent them explicitly with `subscription_code: null`, zero monthly price, and overage equal to observed cost.
- Account detail views should treat bindings and usage independently: return 404 only when both are absent, otherwise show nullable binding fields plus recent usage for troubleshooting.
- Admin auth is owned by `Handler.create`; endpoint tests can exercise non-loopback API-key gating in an isolated Bun process so global Config module caching from other tests cannot mask the behavior.
# Bun Package Distribution & Release Workflow Research

**Date**: May 4, 2026  
**Research Focus**: Official Bun docs, npm bin/files packaging, prepublish scripts, bunx local execution, GitHub Actions setup-bun

---

## 1. Bun Publishing & Packing

### Official Bun Publish Command
**Source**: https://bun.sh/docs/pm/cli/publish

- **`bun publish`** automatically packs, strips catalog/workspace protocols, and publishes to npm registry
- Supports both `bunfig.toml` and `.npmrc` configuration
- **Key flags**:
  - `--dry-run`: Simulate publish without uploading (validates tarball + registry flow)
  - `--access public|restricted`: Set package visibility
  - `--tag <name>`: Publish under dist-tag (default: `latest`)
  - `--tolerate-republish`: Exit 0 if version already exists (useful for CI re-runs)
  - `--auth-type web|legacy`: For 2FA prompts
  - `--otp <code>`: Provide OTP directly (skip prompt)

### Lifecycle Scripts Behavior
**CRITICAL**: Bun only runs lifecycle scripts (`prepublishOnly`, `prepack`, `prepare`, etc.) when **Bun packs the package itself**.

- If you provide a pre-built tarball to `bun publish ./package.tgz`, **scripts are NOT executed**
- This means: build your dist/ in CI, then `bun pm pack` or `bun publish` directly
- **Gotcha**: Don't rely on `prepublishOnly` if you're pre-packing in CI

### Bun PM Pack Command
**Source**: https://bun.sh/docs/install/utilities

```bash
bun pm pack                    # Create .tgz in current dir
bun pm pack --dry-run          # Show what would be included (no file written)
bun pm pack --destination ./   # Specify output directory
bun pm pack --ignore-scripts   # Skip pre/postpack scripts
```

**Behavior**: Follows same rules as `npm pack` — respects `files` field and `.npmignore`

---

## 2. npm package.json Configuration

### `bin` Field (CLI Executables)
**Source**: https://docs.npmjs.com/cli/v10/configuring-npm/package-json

```json
{
  "bin": {
    "agent-cli-proxy": "dist/cli.js",
    "my-tool": "bin/tool.js"
  }
}
```

**Or single executable** (name defaults to package name):
```json
{
  "name": "my-program",
  "bin": "dist/cli.js"
}
```

**Critical requirement**: Executable files MUST start with `#!/usr/bin/env node` shebang
- Without it, scripts run without Node.js interpreter
- Bun-compiled binaries should include this shebang

**Installation behavior**:
- **Global install**: Creates symlink to `/usr/local/bin/` (Unix) or `.cmd` wrapper (Windows)
- **Local install**: Symlinked in `node_modules/.bin/` for use via `npm run` or `npx`
- **bunx**: Can execute local bin scripts with `bunx . <command>` (see section 4)

### `files` Field (Package Contents)
**Source**: https://docs.npmjs.com/cli/v10/configuring-npm/package-json

```json
{
  "files": [
    "dist/",
    "bin/",
    "README.md",
    "LICENSE"
  ]
}
```

**Always included** (regardless of `files` field):
- `package.json`
- `README` (any case/extension)
- `LICENSE` / `LICENCE` (any case/extension)
- Files listed in `bin` field
- Files listed in `main` field

**Always excluded** (cannot be overridden):
- `.git`, `.npmrc`, `node_modules`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`

**Gotcha**: If you don't specify `files`, npm defaults to `["*"]` (includes everything except ignored patterns)
- **Best practice**: Explicitly list `files` to avoid shipping test fixtures, source maps, or `.env` examples

### `.npmignore` vs `.gitignore`
- If `.npmignore` exists, it takes precedence
- If `.npmignore` is missing, `.gitignore` is used instead
- In subdirectories, `.npmignore` overrides root `files` field

---

## 3. Verification Before Publish

### npm pack --dry-run (Universal)
**Works with both npm and Bun**:

```bash
npm pack --dry-run              # List files that would be packed
npm pack --dry-run --json       # JSON output with file sizes
bun pm pack --dry-run           # Bun equivalent
```

**Real-world patterns** (from GitHub Actions workflows):
```bash
# Validate tarball contents
npm pack --dry-run

# Show file list with sizes
npm pack --dry-run --json | jq '.[0].files[].path'

# Verify specific package in monorepo
cd packages/core && npm pack --dry-run
```

### npm publish --dry-run (Registry Validation)
```bash
npm publish --dry-run           # Validates auth, package name, version conflicts
bun publish --dry-run           # Bun equivalent
```

**Difference from `npm pack --dry-run`**:
- `pack --dry-run`: Validates tarball contents only
- `publish --dry-run`: Validates full publish flow (auth, registry, version conflicts)

**Real-world CI pattern**:
```yaml
- name: Verify package contents
  run: bun pm pack --dry-run

- name: Dry-run publish (validate registry)
  env:
    NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: bun publish --dry-run
```

---

## 4. bunx Local Execution (No Global Install)

### bunx . <command>
**Source**: Bun CLI behavior (observed in real workflows)

```bash
bunx . init --non-interactive    # Run local bin script
bunx . service start             # Execute local CLI command
```

**How it works**:
- `bunx .` executes scripts from local `package.json` `bin` field
- No global install needed
- Equivalent to `npm exec` or `npx` but Bun-native
- **Gotcha**: Requires `bin` field in `package.json` to be set

**Real-world usage** (from agent-cli-proxy README):
```bash
# Development (from source)
bun run src/cli.ts init
bun run src/cli.ts service start

# After npm install (published package)
bunx agent-cli-proxy init
agent-cli-proxy service start
```

---

## 5. GitHub Actions with oven-sh/setup-bun

### Official Action
**Source**: https://github.com/oven-sh/setup-bun (v2.2.0 as of May 2026)

```yaml
- uses: oven-sh/setup-bun@v2
```

**Version resolution** (in order):
1. Check `package.json` `packageManager` field (e.g., `"packageManager": "bun@1.0.25"`)
2. Check `package.json` `engines.bun`
3. Use `latest` if neither exists

**Explicit version**:
```yaml
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: latest  # or "canary", "1.0.0", "1.0.x"
```

**Version file**:
```yaml
- uses: oven-sh/setup-bun@v2
  with:
    bun-version-file: ".bun-version"  # or ".tool-versions", "package.json"
```

### Registry Configuration
```yaml
- uses: oven-sh/setup-bun@v2
  with:
    registries: |
      https://registry.npmjs.org/
      @myorg:https://npm.pkg.github.com/|$GITHUB_TOKEN
      @internal:https://username:$INTERNAL_PASSWORD@registry.internal.com/

- name: Install dependencies
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    INTERNAL_PASSWORD: ${{ secrets.INTERNAL_PASSWORD }}
  run: bun install
```

### Outputs
```yaml
- uses: oven-sh/setup-bun@v2
  id: bun

- run: echo "Bun version: ${{ steps.bun.outputs.bun-version }}"
       echo "Bun path: ${{ steps.bun.outputs.bun-path }}"
       echo "Cache hit: ${{ steps.bun.outputs.cache-hit }}"
```

---

## 6. Real-World Release Workflow Patterns

### Pattern 1: Bun-Native Release (Recommended for agent-cli-proxy)
**Source**: https://github.com/frap129/opencode-rules/.github/workflows/release.yml

```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      
      - run: bun install
      - run: bun run build
      
      # Verify package contents
      - run: bun pm pack --dry-run
      
      # Publish to npm
      - run: bun publish --access public
        env:
          NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Advantages**:
- Single tool (Bun) for build + pack + publish
- No npm/pnpm/yarn needed
- Faster CI execution
- Consistent with Bun-only project rules

### Pattern 2: Pre-Build + Publish (For Complex Builds)
**Source**: Multiple real workflows (zama-ai/fhevm, solana-foundation/surfpool)

```yaml
- name: Build
  run: bun run build

- name: Inspect pack contents
  run: bun pm pack --dry-run

- name: Publish dry-run
  env:
    NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: bun publish --dry-run

- name: Publish to npm
  if: github.event_name == 'push'
  env:
    NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: bun publish --access public
```

### Pattern 3: Monorepo Release (Multiple Packages)
**Source**: anomalyco/opentui, apache/iggy

```yaml
- name: Check all packages
  run: |
    for pkg in packages/*/; do
      echo "Checking $pkg..."
      cd "$pkg" && bun pm pack --dry-run && cd ../..
    done

- name: Publish all packages
  run: |
    for pkg in packages/*/; do
      cd "$pkg" && bun publish --access public && cd ../..
    done
  env:
    NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## 7. Gotchas & Best Practices

### Gotcha 1: prepublishOnly Scripts Don't Run with Pre-Built Tarballs
- If you do `bun pm pack` then `bun publish ./package.tgz`, scripts are skipped
- **Solution**: Run build in CI before packing, or let `bun publish` handle packing

### Gotcha 2: Shebang Required for Bin Scripts
- Bun-compiled executables must include `#!/usr/bin/env node` at the top
- Without it, the script runs without Node.js interpreter
- **Check**: `head -1 dist/cli.js` should show shebang

### Gotcha 3: files Field Doesn't Include node_modules
- Even if you list `node_modules` in `files`, npm/Bun will exclude it
- **Solution**: Bundle dependencies into dist/ or use `bundledDependencies`

### Gotcha 4: bunx . Requires bin Field
- `bunx . init` only works if `package.json` has `bin` field
- Without it, Bun doesn't know which script to execute
- **Check**: `cat package.json | grep -A2 '"bin"'`

### Gotcha 5: NPM_CONFIG_TOKEN vs GITHUB_TOKEN
- `NPM_CONFIG_TOKEN`: For npm registry authentication (use for `bun publish`)
- `GITHUB_TOKEN`: For GitHub Packages registry (different endpoint)
- **For public npm**: Use `NPM_CONFIG_TOKEN` from secrets

### Gotcha 6: --tolerate-republish Useful for Idempotent CI
- If CI job re-runs and version already published, use `--tolerate-republish`
- Prevents "version already exists" errors on retry
- **Pattern**: `bun publish --tolerate-republish --access public`

---

## 8. Recommendations for agent-cli-proxy

### package.json Configuration
```json
{
  "name": "agent-cli-proxy",
  "version": "1.0.0",
  "bin": {
    "agent-cli-proxy": "dist/cli.js"
  },
  "files": [
    "dist/",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "bun build src/cli.ts --outfile dist/cli.js --target bun",
    "prepublishOnly": "bun run build"
  }
}
```

### Release Workflow (.github/workflows/release.yml)
```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      
      - run: bun install
      - run: bun run build
      
      # Verify before publish
      - run: bun pm pack --dry-run
      - run: bun publish --dry-run
        env:
          NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}
      
      # Publish
      - run: bun publish --access public
        env:
          NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Local Testing (Before Release)
```bash
# Test bin script locally
bun run build
bunx . init --help

# Verify package contents
bun pm pack --dry-run

# Dry-run publish (requires npm login)
bun publish --dry-run
```

---

## 9. Sources Consulted

1. **Bun Official Docs**
   - https://bun.sh/docs/pm/cli/publish
   - https://bun.sh/docs/install/utilities
   - https://bun.sh/docs/guides/install/cicd

2. **npm Official Docs**
   - https://docs.npmjs.com/cli/v10/configuring-npm/package-json
   - https://docs.npmjs.com/cli/v10/commands/npm-pack
   - https://docs.npmjs.com/cli/v10/commands/npm-publish

3. **GitHub Actions**
   - https://github.com/oven-sh/setup-bun (v2.2.0)
   - Real workflows: frap129/opencode-rules, zama-ai/fhevm, solana-foundation/surfpool, apache/iggy

4. **Real-World Examples**
   - setup-bun package.json (uses esbuild, not Bun build)
   - Multiple monorepo release workflows with `npm pack --dry-run`
   - Bun publish patterns from opencode-rules and letta-ai/letta-code


# Docker Removal & OSS Repository Hardening (May 4, 2026)

**Task**: Wave 1 - Repo Docker purge + README cleanup  
**Status**: COMPLETED  
**Date**: 2026-05-04

## Summary

Removed all Docker artifacts from the repository and updated OSS documentation to reflect npm package distribution and systemd/launchd service management.

## Changes Made

### 1. Deleted Tracked Docker Files
- `Dockerfile` (removed from git)
- `docker-compose.yml` (removed from git)
- `.dockerignore` (removed from git)

**Verification**: `git ls-files | grep -Ei 'docker|^\.dockerignore$'` returns empty (exit code 1) ✓

### 2. Updated LICENSE
- Changed copyright from `Copyright (c) 2026 INONONO66` to `Copyright (c) 2026 Agent CLI Proxy contributors`
- Maintains MIT license text unchanged
- Aligns with OSS best practices for community-driven projects

### 3. Created CONTRIBUTING.md
- Placeholder-but-useful guide for contributors
- Covers: fork/clone, development setup, testing, submission process, code style, issue reporting
- References Bun-native tooling (`bun install`, `bun test`, `bun run`)
- Kept concise for T18 expansion

### 4. Created SECURITY.md
- Security vulnerability reporting guidelines
- Email-based disclosure process (placeholder: security@example.com)
- Configuration security best practices (API keys, credentials, .env handling)
- Update guidance for users
- Kept concise for T18 expansion

### 5. README.md Verification
- Already contains correct installation paths:
  - `bunx agent-cli-proxy init` (npm package install)
  - `systemctl --user enable --now agent-cli-proxy` (Linux systemd)
  - Mentions launchd agent generation for macOS
- No Docker references in installation instructions
- No changes needed ✓

### 6. .gitignore Review
- Checked for Docker-specific duplicates from `.dockerignore`
- `.dockerignore` contained: `node_modules/`, `.git/`, `data/*.db`, `.env`, `dist/`, `tests/`, `*.test.ts`
- All overlapping patterns already in `.gitignore`
- No Docker-specific patterns to remove
- No changes needed ✓

## QA Verification Results

### Test 1: No Docker Files Tracked
```
Command: git ls-files | grep -Ei 'docker|^\.dockerignore$'
Result: No matches (exit code 1)
Status: PASS ✓
```

### Test 2: No Docker Mentions in Code
```
Command: git grep -ni 'docker' -- ':!.sisyphus' ':!.git' ':!node_modules'
Result: No matches (exit code 1)
Status: PASS ✓
```

### Test 3: README Contains Correct Paths
```
Command: grep -E 'bunx agent-cli-proxy|systemctl --user|launchd' README.md
Result: 3 matches found (exit code 0)
Status: PASS ✓

Matches:
1. bunx agent-cli-proxy init
2. The CLI avoids shell installer files for normal use. It generates systemd user services on Linux and launchd agents on macOS.
3. systemctl --user enable --now agent-cli-proxy  # Linux
```

## Evidence Saved

- `.sisyphus/evidence/task-1-no-docker.txt` - Docker removal verification
- `.sisyphus/evidence/task-1-readme-paths.txt` - README paths verification

## Key Learnings

1. **Docker Removal Scope**: Only tracked files needed removal; no Docker references in source code or production docs
2. **README Already Aligned**: Installation instructions already used bunx/npm package paths and systemd/launchd
3. **OSS Documentation**: CONTRIBUTING.md and SECURITY.md are placeholders for T18 expansion; kept concise but valid
4. **License Attribution**: Changed to "contributors" model for community-driven OSS
5. **No .gitignore Cleanup Needed**: Docker-specific patterns were already covered by existing rules

## Blockers & Dependencies

- None. Task is independent and complete.
- Blocks T18 (docs expansion) and T20 (release workflow setup)

## Next Steps (T18/T20)

- Expand CONTRIBUTING.md with detailed development guide, architecture overview, testing patterns
- Expand SECURITY.md with vulnerability disclosure SLA, supported versions, security update process
- Set up GitHub Actions release workflow (bun publish, npm registry)
- Add CHANGELOG.md for release notes tracking


# Structured Logger Module (2026-05-04 13:41:50 UTC)

**Task**: Wave 1 - T2 structured logger module  
**Status**: COMPLETED

## Summary

Added `src/util/logger.ts` with dependency-free structured logging and migrated production `src/` call sites away from raw `console.log|warn|error|info`.

## Key Learnings

1. **Logger API shape**: `Logger.create({ level, base })`, `Logger.fromConfig()`, and `logger.child({ request_id })` are enough for current server, storage, provider, correlator, and CLI migration needs.
2. **Sink injection keeps tests stable**: Unit tests capture `stdout` and `stderr` through an injected sink instead of patching globals or relying on raw console calls.
3. **Default output policy**: `info`, `warn`, and `debug` go to stdout; `error` goes to stderr. JSON is default and `LOG_FORMAT=pretty` enables readable text output.
4. **Recursive redaction is mandatory**: Redaction needs to match nested keys and casing variants such as `authorization`, `X-Api-Key`, `access_token`, `password`, and `clientSecret`.
5. **CLI output preservation**: User-facing CLI help/success text can be kept readable with explicit stdout/stderr helpers while production diagnostics use structured logger calls.

## Verification Notes

- `bun test tests/unit/logger.test.ts` passed.
- `git grep -nE 'console\\.(log|warn|error|info)' src` returned no matches after migration.
- `bun run test` and `bun run build` passed.
- `bunx tsc --noEmit` still fails in unchanged `test-inspector.ts`, matching inherited context and not introduced by T2.


# Strict Config Validator (2026-05-04 13:53 UTC)

**Task**: Wave 1 - T3 strict config validator with safe defaults  
**Status**: COMPLETED

## Key Learnings

1. **Validated singleton plus explicit API**: Keeping `src/config/index.ts` as a frozen validated object preserves existing `Config.port` consumers, while `src/config/validate.ts` exposes `Config.validate(env)` for tests and future doctor/readiness checks.
2. **Startup catch requires dynamic imports**: `src/index.ts` must import config-dependent modules inside `main()` so validation failures can be caught and logged with structured `event="config.error"` instead of failing during static module evaluation.
3. **CLI import hygiene matters**: `src/cli.ts` cannot statically import modules that transitively load `src/config`; commands like `init` should continue working before an env file exists, while config-dependent commands validate after loading env values.
4. **Local fallback is now explicit**: Missing `CLI_PROXY_API_URL` fails fast unless `PROXY_LOCAL_OK=1`, which keeps safe production defaults without breaking intentional local development.
5. **Provider config validation stays intentionally shallow**: T3 validates inline/file JSON shape and field paths such as `providers[0].id` without implementing provider registry reload or runtime routing behavior reserved for later tasks.

## Verification Notes

- `bun test tests/unit/config.test.ts` passed.
- `bun run test` passed.
- `bun run build` passed.
- QA micro-scripts saved structured fail-fast/provider-schema evidence under `.sisyphus/evidence/task-3-*`.

## 2026-05-04 T4 lifecycle/cost migration
- `request_logs.status` remains numeric HTTP status; lifecycle state uses `lifecycle_status` with indexes and repo defaults.
- Migration 005 should be tested directly against an old schema so db.ts compatibility shims cannot mask missing DDL/backfill behavior.
- Terminal insert defaults: HTTP >=400, `incomplete=1`, or `error_code` -> lifecycle `error`; positive cost -> cost_status `ok`, otherwise terminal zero-cost rows -> `pending`.

## 2026-05-04 T5 provider registry schema
- Shared provider validation now lives in src/provider/registry-schema.ts, with structured paths such as provider.id and providers[1].upstreamBaseUrl and no auth value leakage in issue messages.
- ProviderRegistry stays scoped: built-ins for anthropic/openai route to Config.cliProxyApiUrl, custom config uses PROVIDERS_JSON before PROVIDERS_CONFIG_PATH, corrupt entries warn once and are dropped, and forceReload bypasses the memoized cache.
- Config.validate can reuse the shared schema without importing ProviderRegistry, avoiding a Config <-> registry circular import.

## 2026-05-04 T6 plans JSON module
- Plans module remains dependency-free and sync: PLANS_JSON > PLANS_PATH > XDG config > bundled data/plans.default.json, with a memoized list/map and reload for rereads.
- Schema validation reports paths like plans[0].code and plans[0].monthly_price_usd; corrupt selected sources warn through structured logger and fall back to packaged defaults.
- Default plan metadata is monthly-price subscription metadata only; no quota windows or token pricing belong in data/plans.default.json.

## 2026-05-04 T7 resilient upstream client
- Upstream resiliency is centralized in `src/upstream/client.ts`; scoped call sites in pass-through, CLIProxy management usage, and quota probes now route through `UpstreamClient.fetch` without migrating unrelated fetch users.
- Retry safety is opt-in with `idempotent === true`, capped at two retries, and streaming is conservatively detected from `ReadableStream` request bodies or `text/event-stream` headers so streaming requests are never retried.
- Circuit breaker state is keyed by `providerId`: five consecutive final failures opens it, 30s elapsed transitions to half-open, and a half-open success closes it.
- The client logs normalized failures with `event="upstream.error"`; short-circuit responses additionally log `event="upstream.short_circuit"` and return a 503 JSON error without touching upstream response bodies.

## 2026-05-05 T8 lifecycle
- Pass-through now owns a two-phase request lifecycle: `RequestRepo.insert()` creates a `pending`/`unresolved` row before calling `UpstreamClient.fetch`, and `UsageService.finalizeUsage()` updates that same row exactly once after success, HTTP error, stream cancel/error, or abort.
- `RequestRepo.updateFinalize()` was chosen over separate lifecycle + usage updates so tokens, cost, status, `finalized_at`, and lifecycle state move atomically under one SQLite transaction; the `WHERE lifecycle_status='pending'` guard prevents duplicate daily aggregation if finalization is attempted twice.
- Bun streams need an explicit output `ReadableStream` wrapper around `pipeThrough()` to observe client-side `cancel()`. `TransformStream.flush()` only runs when upstream closes cleanly, so abort handling must live in the wrapper's `cancel`/read error paths.
- A final SSE line without a trailing newline must be processed by the same line parser as normal chunks and then enqueued; otherwise the final usage-bearing event can update storage while disappearing from the client response.
- Rewritten Anthropic JSON bodies cannot reuse inbound transfer headers. Strip `content-length`, `content-encoding`, and `accept-encoding`; set `content-type: application/json` on rewritten `/v1/messages` requests and let fetch recompute length.
- Boot recovery stays outside `initDb()` and is wired in `src/index.ts` immediately after migrations so tests and CLI callers can opt into `Storage.recoverStalePending(db, maxAgeMs)` without surprising side effects.

## 2026-05-05 T11 supervisor
- `Supervisor.run()` keeps loop crash isolation centralized: loop callbacks should not swallow scheduling-level errors if we want exponential backoff and structured `loop.error` telemetry to work.
- Startup one-shot work and periodic work should be distinct. Pricing still does the startup `fetchPricing()` while `Pricing.startBackgroundRefresh()` schedules the later refresh interval with `runOnStart: false`.
- Quota refresh should not tick forever when local auth is not configured. `UsageService.startQuotaRefresh()` checks `CLIPROXY_AUTH_DIR` and JSON auth files once, logs a single skip event, and only registers a supervised loop when there is something to probe.
- Shutdown composition is registry-first: individual handles abort their loop and `Supervisor.stopAll()` drains registered loops in parallel with bounded timeout logging for abandoned loops.
- Tests are easiest with a supervisor test logger sink and real small millisecond intervals; jitter disabled (`jitterRatio: 0`) makes backoff assertions deterministic without new dependencies.
- The existing cost backfill TODO in `UsageService` was also moved under Supervisor so the scoped `setInterval` audit stays clean and T15 can drain it through the same registry.

## 2026-05-05 T15 graceful shutdown
- Keep Bun signal handlers memoized at module scope. Repeated `Shutdown.register()` calls must return the same pending shutdown promise and avoid remove/re-add cycles in normal runtime because Bun can reset kernel signal state when listeners are removed.
- Test process safety is best handled by injecting an `exit` callback and exposing a test-only reset; startup wiring still avoids handler registration when `NODE_ENV=test` or `DISABLE_SHUTDOWN_HANDLERS=1`.
- Shutdown finalization should select pending request log ids and route each through `RequestRepo.updateLifecycle()` so lifecycle state, `error_message='shutdown'`, and `finalized_at` use the existing repo update path.
- `Storage.recoverStalePending()` was already wired before `Bun.serve()` and already uses `error_message='boot-recovery'` with `STALE_PENDING_MAX_AGE_MS`, so T15 only needed verification rather than a storage migration.
- Unit tests should prefer a fake Bun server exposing `pendingRequests`, `pendingWebSockets`, and `stop(closeActiveConnections)` over process-level integration; this makes drain and hard-kill timing deterministic.

## 2026-05-05 T16 default plans.json packaging
- `data/plans.default.json` is statically imported by `src/plans/index.ts` via `import defaultPlansDocument from "../../data/plans.default.json"`. Bun bundles this JSON at build time, so the dist bundle already embeds the data — no runtime path resolution is needed for the default case.
- The `dist/data/plans.default.json` copy (added to build script) is a convenience artifact: it lets users inspect/override the file after install and serves as a reference for `PLANS_PATH` env var usage.
- Adding `"data"` to `package.json` `files` ensures the source JSON ships with the npm package alongside `dist/`, giving users access to the raw file without needing to unpack the bundle.
- `local_byok` must omit `vendor_url` entirely (not set to `""`) because the schema validator's `readOptionalHttpUrl` rejects empty strings. Optional fields should be absent, not empty.
- All `notes` fields must include "verify with vendor" to satisfy the new test assertion and to communicate pricing staleness to users. The format `"Conservative estimate — verify with vendor — last updated YYYY-MM"` is the canonical pattern.
- 9 plans total: claude_pro, claude_max5, claude_max20, chatgpt_plus, chatgpt_pro, chatgpt_business, kimi_pro, glm_pro, local_byok. Existing tests that assert specific `display_name` values must be updated when names change (e.g., "Claude Pro" → "Anthropic Claude Pro").

## 2026-05-05 T14 CLI hardening

- Keep CLI imports validation-light: `src/cli.ts` should import `Config.validate` from `config/validate` directly and dynamically import config-singleton consumers only after env files have been applied.
- `init --non-interactive` must never require a prompt; secrets belong in env-backed flags (`--admin-token-env`, `--cliproxy-mgmt-key-env`) or existing environment variables, not echoed stdin prompts.
- `.env` writes should be same-directory temp-file + rename with mode `0600`. Refusing overwrite by default is safer than silently replacing admin/upstream secrets; `--merge` preserves already-written values.
- Doctor checks are most useful as a full structured report even when config fails. Downstream checks that depend on validated config should report an explicit skipped/fail reason instead of aborting the process.
- Spawning the CLI from tests while hosting a local Bun server must use asynchronous `Bun.spawn`; `spawnSync` blocks the test process event loop and makes the child doctor probe time out.
