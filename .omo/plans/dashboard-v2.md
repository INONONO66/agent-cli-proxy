# Dashboard v2 — Overhaul with Graphs, API Keys, and Improved UX

## TL;DR

> **Quick Summary**: Overhaul the admin dashboard with browser noise filtering, improved quota cards (grouped by account with pace insights), usage time-series graphs, API key management, richer log filters, and OAuth UX improvements — referencing codex-lb and Claude-Usage-Tracker.
>
> **Deliverables**:
> - Browser noise allowlist filter in handler.ts
> - Recharts-based usage graphs (quota trends + request/cost trends)
> - API key CRUD system (migration 008, endpoints, per-key tracking, dashboard page)
> - Improved quota cards (account grouping, session/weekly split, pace insights)
> - Enhanced log filters (model, provider, status) backend + frontend
> - Improved OAuth dialog UX
> - quota_snapshots retention cleanup in supervisor
>
> **Estimated Effort**: XL (5-7 days)
> **Parallel Execution**: YES — 4 waves
> **Critical Path**: Noise filter → Log filters → API keys migration → Graphs backend → Frontend improvements

---

## Context

### Current State
- Dashboard v1 deployed: React SPA at `/dashboard/*` with QuotasPage, LogsPage, UsagePage, OAuthPage
- Cookie session auth + bearer token dual auth working
- OAuth login via CLIProxyAPI subprocess + SSE
- normalizePercent 1%→100% bug fixed
- Browser requests (favicon.ico, .well-known) polluting request_logs
- Quota cards show flat list without account grouping
- No usage graphs — tables only
- No API key system — single shared CLI_PROXY_API_KEY
- Log filters limited to tool and client_id only

### Reference Projects
- **codex-lb** (github.com/Soju06/codex-lb): Account cards, API key CRUD, rich log filters, 28-day trends, OAuth modal with browser/device/manual callback
- **Claude-Usage-Tracker** (github.com/hamed-elfayome/Claude-Usage-Tracker): Session(5h)/weekly split, per-model (Opus/Sonnet), pace insights, 5h/24h/7d/30d history charts

### Metis Review
**Identified Gaps** (addressed):
- Browser noise filter: allowlist vs blocklist → user chose allowlist
- API key scope: identification-only, no enforcement
- Graph data source: both quota_snapshots + request_logs
- Charts: library allowed (user removed CSS-only constraint)
- quota_snapshots retention: needs cleanup job (30d)
- API key migration safety: SQLite ALTER TABLE ADD COLUMN is safe

---

## Work Objectives

### Core Objective
Overhaul the admin dashboard with improved visualization, API key management, and cleaner data — referencing codex-lb and Claude-Usage-Tracker patterns.

### Concrete Deliverables
- `src/server/handler.ts`: Allowlist filter for passthrough
- `src/storage/migrations/008_api_keys.sql`: API keys table + request_logs column
- `src/storage/api-keys.ts`: API key repo
- `src/admin/api-keys.ts`: API key CRUD endpoints
- `src/admin/index.ts`: Extended log filter query params
- `src/storage/repo.ts`: Extended getRecent with model/provider/status filters
- `src/admin/index.ts`: Quota history endpoint
- `src/runtime/supervisor.ts`: quota_snapshots retention cleanup
- `src/dashboard/pages/QuotasPage.tsx`: Redesigned with account grouping + pace
- `src/dashboard/pages/LogsPage.tsx`: Enhanced filters
- `src/dashboard/pages/UsagePage.tsx`: Time-series graphs
- `src/dashboard/pages/ApiKeysPage.tsx`: New page for key management
- `src/dashboard/pages/OAuthPage.tsx`: Improved dialog UX
- `src/dashboard/components/`: New chart components, account group cards
- `package.json`: Add recharts dependency

### Must Have
- Allowlist passthrough filter (only /v1/, /api/ paths proxied)
- Quota cards grouped by account with session/weekly separation
- Usage graphs with 5h/24h/7d/30d zoom
- API key create/list/revoke with per-key usage tracking
- Log filters: model, provider, status (AND-combined)
- quota_snapshots 30d retention cleanup
- OAuth dialog UX improvement (provider grouping, copy buttons, clearer status steps)

### Must NOT Have
- Rate limiting per API key
- API key expiration or rotation
- Frontend test framework (jest-dom, testing-library)
- Abstract CRUD helper classes
- Separate CSS files per component
- SVG/canvas custom rendering engine (use Recharts)
- Additional routing library
- `as any` / `@ts-ignore` / `@ts-expect-error`

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES (bun test)
- **Automated tests**: Tests-after for new backend features
- **Framework**: bun test
- **Frontend**: No unit tests — Playwright + curl QA scenarios

### QA Policy
Every task includes agent-executed QA scenarios.
Evidence saved to `.omo/evidence/task-{N}-{scenario-slug}.{ext}`.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — all independent, no dependencies):
├── 1. Browser noise allowlist filter [quick]
├── 2. Log filter backend (model/provider/status params) [quick]
├── 3. Migration 008: api_keys table + request_logs.proxy_api_key_id [quick]
├── 4. Quota history endpoint (time-series from quota_snapshots) [quick]
├── 5. Request/cost time-series endpoint (from request_logs) [quick]
├── 6. quota_snapshots retention cleanup in supervisor [quick]
├── 9. Add recharts dependency + verify build [quick]
└── 14. OAuthPage: improved dialog UX [visual-engineering]

Wave 2 (Depends on Wave 1):
├── 7. API key repo + CRUD endpoints (depends: 3) [unspecified-high]
└── 8. API key identification middleware in pass-through (depends: 3, 7) [quick]

Wave 3 (Frontend — depends on Wave 1+2 backends):
├── 10. QuotasPage redesign: account grouping + pace insights (depends: 4) [visual-engineering]
├── 11. UsagePage: time-series graphs with Recharts (depends: 4, 5, 9) [visual-engineering]
├── 12. LogsPage: enhanced filters UI (depends: 2) [visual-engineering]
└── 13. ApiKeysPage: new page with CRUD UI (depends: 7) [visual-engineering]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── F1. Plan compliance audit (oracle)
├── F2. Code quality review (unspecified-high)
├── F3. Real manual QA (unspecified-high)
└── F4. Scope fidelity check (deep)
-> Present results -> Get explicit user okay
```

### Dependency Matrix
- **1-6**: None — all can start immediately
- **7**: 3 — needs api_keys table
- **8**: 3, 7 — needs repo + table
- **9**: None
- **10**: 4 — needs quota history endpoint
- **11**: 4, 5, 9 — needs both time-series endpoints + recharts
- **12**: 2 — needs log filter backend
- **13**: 7 — needs API key CRUD endpoints
- **14**: None

### Agent Dispatch Summary
- **Wave 1**: 8 tasks → `quick` (1-6, 9), `visual-engineering` (14)
- **Wave 2**: 2 tasks → `unspecified-high` (7), `quick` (8)
- **Wave 3**: 4 tasks → `visual-engineering` (10-13)
- **FINAL**: 4 tasks → `oracle` (F1), `unspecified-high` (F2, F3), `deep` (F4)

---

## TODOs

- [x] 1. Browser noise allowlist filter

  **What to do**:
  - In `src/server/handler.ts`, before the passthrough fallback (after `/admin/*` block), add an allowlist check
  - Only proxy requests whose path starts with `/v1/` or `/api/` (case-sensitive)
  - All other non-reserved paths return 404 JSON `{"error":"not found"}`
  - Reserved paths (`/health`, `/ready`, `/metrics`, `/dashboard/*`, `/admin/*`) already handled above

  **Must NOT do**:
  - Do NOT use a configurable blocklist — hardcode the allowlist
  - Do NOT change existing reserved path handling

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2-6)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `src/server/handler.ts:110-158` — current passthrough fallback block
  - Metis directive: "filter in handler.ts BEFORE passthrough, allowlist approach"

  **Acceptance Criteria**:
  ```
  Scenario: favicon.ico no longer proxied
    Tool: curl
    Steps:
      1. curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/favicon.ico
    Expected Result: HTTP 404
    Evidence: .omo/evidence/task-1-favicon-blocked.txt

  Scenario: .well-known no longer proxied
    Tool: curl
    Steps:
      1. curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/.well-known/appspecific/com.chrome.devtools.json
    Expected Result: HTTP 404
    Evidence: .omo/evidence/task-1-wellknown-blocked.txt

  Scenario: /v1/chat/completions still proxied
    Tool: curl
    Steps:
      1. curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3100/v1/chat/completions -H 'Content-Type: application/json' -d '{}'
    Expected Result: HTTP != 404 (upstream error is fine, but NOT 404)
    Evidence: .omo/evidence/task-1-v1-still-proxied.txt

  Scenario: noise not in logs
    Tool: curl
    Steps:
      1. curl http://127.0.0.1:3100/favicon.ico
      2. curl -s -H 'Authorization: Bearer $ADMIN_API_KEY' 'http://127.0.0.1:3100/admin/logs?limit=3'
    Expected Result: No favicon.ico entries in recent logs
    Evidence: .omo/evidence/task-1-no-noise-logs.txt
  ```

  **Commit**: YES
  - Message: `fix(server): add allowlist passthrough filter for known API paths`
  - Files: `src/server/handler.ts`

- [x] 2. Log filter backend — model, provider, status params

  **What to do**:
  - In `src/storage/repo.ts`, extend `RequestRepo.getRecent()` to accept optional `model`, `provider`, `status`, `lifecycle_status` filter params
  - Build WHERE clauses dynamically with parameterized queries (no SQL injection)
  - All filters AND-combined
  - `model`: exact match
  - `provider`: exact match
  - `status`: exact integer match (single value) OR `status_min` + `status_max` for range (e.g. 200-299 for 2xx)
  - `lifecycle_status`: exact match
  - In `src/admin/index.ts`, read new query params from URL and pass to `getRecent()`

  **Must NOT do**:
  - Do NOT use LIKE or prefix matching
  - Do NOT change the response shape

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3-6)
  - **Blocks**: 12 (frontend log filters)
  - **Blocked By**: None

  **References**:
  - `src/storage/repo.ts` — `RequestRepo.getRecent()` current implementation
  - `src/admin/index.ts:137-155` — current log endpoint with tool/client_id params
  - codex-lb: rich filter approach in recent-requests-table.tsx

  **Acceptance Criteria**:
  ```
  Scenario: Filter by model
    Tool: curl
    Steps:
      1. curl -s -H 'Authorization: Bearer $TOKEN' 'http://127.0.0.1:3100/admin/logs?model=grok-4.3&limit=5'
    Expected Result: All returned logs have model=grok-4.3
    Evidence: .omo/evidence/task-2-filter-model.json

  Scenario: Filter by provider
    Tool: curl
    Steps:
      1. curl -s -H 'Authorization: Bearer $TOKEN' 'http://127.0.0.1:3100/admin/logs?provider=openai&limit=5'
    Expected Result: All returned logs have provider=openai
    Evidence: .omo/evidence/task-2-filter-provider.json

  Scenario: Combined filters
    Tool: curl
    Steps:
      1. curl -s -H 'Authorization: Bearer $TOKEN' 'http://127.0.0.1:3100/admin/logs?provider=openai&status=200&limit=5'
    Expected Result: All logs have provider=openai AND status=200
    Evidence: .omo/evidence/task-2-filter-combined.json
  ```

  **Commit**: YES
  - Message: `feat(admin): add model, provider, and status filters to request logs`
  - Files: `src/storage/repo.ts`, `src/admin/index.ts`

- [x] 3. Migration 008: api_keys table + request_logs column

  **What to do**:
  - Create `src/storage/migrations/008_api_keys.sql`:
    ```sql
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      last_used_at TEXT
    );
    ALTER TABLE request_logs ADD COLUMN proxy_api_key_id INTEGER REFERENCES api_keys(id);
    ```
  - Store only a SHA-256 hash of the key (never plaintext). Store a 8-char prefix for display.
  - The full key is returned ONCE at creation time, never again.

  **Must NOT do**:
  - Do NOT store plaintext API keys
  - Do NOT modify existing migration files (001-007)
  - Do NOT add indexes on request_logs yet (large table risk)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1-2, 4-6)
  - **Blocks**: 7, 8 (API key repo + middleware)
  - **Blocked By**: None

  **References**:
  - `src/storage/migrations/` — existing migration files for naming pattern
  - `src/storage/db.ts` — migration runner
  - codex-lb: encrypted token storage pattern

  **Acceptance Criteria**:
  ```
  Scenario: Migration applies cleanly
    Tool: bun test
    Steps:
      1. Delete test DB, run server, check api_keys table exists
      2. Check request_logs has proxy_api_key_id column
    Expected Result: Both exist, no migration errors
    Evidence: .omo/evidence/task-3-migration.txt
  ```

  **Commit**: YES
  - Message: `feat(storage): add api_keys table and proxy_api_key_id column (migration 008)`
  - Files: `src/storage/migrations/008_api_keys.sql`

- [x] 4. Quota history time-series endpoint

  **What to do**:
  - Add `GET /admin/quotas/history?hours=5&provider=claude&account=...` endpoint
  - Query `quota_snapshots` table grouped by time buckets (auto-select bucket size: 5min for 5h, 1hr for 24h, 4hr for 7d, 1day for 30d)
  - Return `{ buckets: [{ timestamp, snapshots: [{provider, account, quota_type, used_pct}] }] }`
  - Default: last 24 hours

  **Must NOT do**:
  - Do NOT return raw individual rows (too many) — aggregate into buckets
  - Do NOT add a new table

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 10, 11 (frontend graphs)
  - **Blocked By**: None

  **References**:
  - `src/storage/repo.ts` — `QuotaRepo` namespace for quota queries
  - `quota_snapshots` table schema in migration 002
  - Claude-Usage-Tracker: 5h/24h/7d/30d zoom levels

  **Acceptance Criteria**:
  ```
  Scenario: 5-hour history
    Tool: curl
    Steps:
      1. curl -s -H 'Authorization: Bearer $TOKEN' 'http://127.0.0.1:3100/admin/quotas/history?hours=5'
    Expected Result: JSON with buckets array, each bucket has timestamp + snapshots array
    Evidence: .omo/evidence/task-4-quota-history.json

  Scenario: Filter by provider
    Tool: curl
    Steps:
      1. curl -s -H 'Authorization: Bearer $TOKEN' 'http://127.0.0.1:3100/admin/quotas/history?hours=24&provider=claude'
    Expected Result: Only claude provider snapshots in buckets
    Evidence: .omo/evidence/task-4-quota-history-filtered.json
  ```

  **Commit**: YES
  - Message: `feat(admin): add quota history time-series endpoint`
  - Files: `src/storage/repo.ts`, `src/admin/index.ts`

- [x] 5. Request/cost time-series endpoint

  **What to do**:
  - Add `GET /admin/usage/trend?hours=24&bucket=1h` endpoint
  - Query `request_logs` aggregated by time bucket: `{ buckets: [{ timestamp, requests, tokens, cost_usd }] }`
  - Support optional `provider`, `model`, `tool` filters
  - Auto-select bucket: 5min for ≤5h, 1h for ≤24h, 4h for ≤7d, 1d for ≤30d

  **Must NOT do**:
  - Do NOT return individual request rows

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 11 (frontend graphs)
  - **Blocked By**: None

  **References**:
  - `src/storage/repo.ts` — `RequestRepo` namespace
  - `src/storage/service.ts` — `UsageService` aggregation patterns

  **Acceptance Criteria**:
  ```
  Scenario: 24-hour trend
    Tool: curl
    Steps:
      1. curl -s -H 'Authorization: Bearer $TOKEN' 'http://127.0.0.1:3100/admin/usage/trend?hours=24'
    Expected Result: JSON with buckets array, each has timestamp/requests/tokens/cost_usd
    Evidence: .omo/evidence/task-5-usage-trend.json
  ```

  **Commit**: YES
  - Message: `feat(admin): add request/cost time-series endpoint`
  - Files: `src/storage/repo.ts`, `src/admin/index.ts`

- [x] 6. quota_snapshots retention cleanup

  **What to do**:
  - Add a retention cleanup function in `src/storage/repo.ts` under `QuotaRepo`
  - Delete quota_snapshots older than 30 days
  - Register in `src/runtime/supervisor.ts` as a daily loop (every 24h)
  - Log deleted count

  **Must NOT do**:
  - Do NOT downsample (just delete old rows)
  - Do NOT run more frequently than daily

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `src/runtime/supervisor.ts` — existing loop registration pattern
  - `src/storage/repo.ts` — `QuotaRepo` namespace

  **Acceptance Criteria**:
  ```
  Scenario: Cleanup registered
    Tool: curl
    Steps:
      1. curl -s http://127.0.0.1:3100/ready
    Expected Result: supervisor.loops includes "quota-retention" or similar
    Evidence: .omo/evidence/task-6-retention-registered.json
  ```

  **Commit**: YES
  - Message: `feat(runtime): add quota_snapshots retention cleanup to supervisor`
  - Files: `src/storage/repo.ts`, `src/runtime/supervisor.ts`, `src/index.ts`

- [x] 7. API key repo + CRUD endpoints

  **What to do**:
  - Create `src/storage/api-keys.ts` with `ApiKeyRepo` namespace:
    - `create(db, name) → { id, key, keyPrefix, name, createdAt }` — generate random 32-byte key, store SHA-256 hash
    - `list(db) → [{id, keyPrefix, name, createdAt, revokedAt, lastUsedAt, requestCount}]`
    - `revoke(db, id) → boolean`
    - `findByHash(db, keyHash) → {id, name} | null`
    - `touchLastUsed(db, id) → void`
  - Create `src/admin/api-keys.ts` with endpoints:
    - `GET /admin/api-keys` — list all keys
    - `POST /admin/api-keys` — create key, body `{"name":"..."}`, returns full key ONCE
    - `DELETE /admin/api-keys/:id` — revoke key
    - `GET /admin/api-keys/:id/usage` — per-key usage summary from request_logs
  - Wire into `src/admin/index.ts`

  **Must NOT do**:
  - Do NOT add rate limiting per key
  - Do NOT add key expiration
  - Do NOT log or expose the full key after creation

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 2)
  - **Parallel Group**: Wave 2
  - **Blocks**: 8, 13 (middleware + frontend)
  - **Blocked By**: 3 (migration)

  **References**:
  - `src/storage/repo.ts` — repo pattern (prepared statements, namespace exports)
  - `src/admin/oauth.ts` — admin endpoint pattern
  - `src/storage/migrations/008_api_keys.sql` — table schema
  - codex-lb: API key lifecycle in apis-page.tsx

  **Acceptance Criteria**:
  ```
  Scenario: Create API key
    Tool: curl
    Steps:
      1. curl -s -X POST http://127.0.0.1:3100/admin/api-keys -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -H 'x-csrf: 1' -d '{"name":"test-key"}'
    Expected Result: 200, response has {id, key, key_prefix, name, created_at}. key is 64+ chars.
    Evidence: .omo/evidence/task-7-create-key.json

  Scenario: List API keys
    Tool: curl
    Steps:
      1. curl -s http://127.0.0.1:3100/admin/api-keys -H 'Authorization: Bearer $TOKEN'
    Expected Result: Array includes the created key with key_prefix visible, NO full key
    Evidence: .omo/evidence/task-7-list-keys.json

  Scenario: Revoke API key
    Tool: curl
    Steps:
      1. curl -s -X DELETE http://127.0.0.1:3100/admin/api-keys/:id -H 'Authorization: Bearer $TOKEN' -H 'x-csrf: 1'
    Expected Result: 200, key has revoked_at set
    Evidence: .omo/evidence/task-7-revoke-key.json
  ```

  **Commit**: YES
  - Message: `feat(admin): add API key CRUD endpoints`
  - Files: `src/storage/api-keys.ts`, `src/admin/api-keys.ts`, `src/admin/index.ts`

- [x] 8. API key identification in pass-through

  **What to do**:
  - In `src/server/request-inspector.ts` or `src/server/pass-through.ts`, check for a dedicated `x-proxy-key` header (NOT `Authorization` or `x-api-key` — those are used by upstream CLIProxyAPI auth and admin auth respectively)
  - Hash the key value, lookup via `ApiKeyRepo.findByHash()`
  - If found: set `proxy_api_key_id` on the request log row, call `touchLastUsed()`
  - If not found or no key: leave proxy_api_key_id as NULL (no rejection — identification only)
  - Strip the `x-proxy-key` header before forwarding to upstream (don't leak proxy internals)
  - Pass key ID through to the pre-log/finalize flow

  **Must NOT do**:
  - Do NOT reject requests without a proxy API key
  - Do NOT use `Authorization` header (reserved for upstream CLIProxyAPI auth)
  - Do NOT use `x-api-key` header (reserved for admin API auth)
  - Do NOT use `x-admin-token` header (reserved for admin bearer)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 2)
  - **Parallel Group**: Wave 2
  - **Blocks**: None
  - **Blocked By**: 3, 7 (migration + repo)

  **References**:
  - `src/server/pass-through.ts` — preLog/finalize flow
  - `src/server/request-inspector.ts` — RequestInspector.inspect()
  - `src/storage/api-keys.ts` — findByHash/touchLastUsed

  **Acceptance Criteria**:
  ```
  Scenario: Request with proxy API key is attributed
    Tool: curl
    Steps:
      1. Create a key via POST /admin/api-keys
      2. Make a request with x-proxy-key header set to the full key
      3. Check /admin/logs — latest log should have proxy_api_key_id set
    Expected Result: proxy_api_key_id is non-null for the request
    Evidence: .omo/evidence/task-8-key-attribution.json

  Scenario: Request without key still works
    Tool: curl
    Steps:
      1. Make a request without x-proxy-key header
    Expected Result: Request proxied normally, proxy_api_key_id is null
    Evidence: .omo/evidence/task-8-no-key-still-works.json
  ```

  **Commit**: YES
  - Message: `feat(server): identify requests by proxy API key`
  - Files: `src/server/pass-through.ts`, `src/server/request-inspector.ts`

- [x] 9. Add recharts dependency

  **What to do**:
  - `bun add recharts`
  - Verify `bun run build` still works with recharts in the dashboard bundle
  - Verify bundle size is acceptable

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1-6, 14)
  - **Blocks**: 11 (usage graphs)
  - **Blocked By**: None

  **Acceptance Criteria**:
  ```
  Scenario: Build succeeds with recharts
    Tool: bash
    Steps:
      1. bun run build
    Expected Result: Exit 0, dist/dashboard/ has JS bundle
    Evidence: .omo/evidence/task-9-build-with-recharts.txt
  ```

  **Commit**: YES
  - Message: `build: add recharts dependency`
  - Files: `package.json`, `bun.lock`

- [x] 10. QuotasPage redesign: account grouping + pace insights

  **What to do**:
  - Group quota cards by account (provider + email)
  - Each account group shows all quota windows (session/5h, weekly, model-specific) in one card
  - Add pace insight: "At current rate, limit in ~Xh" based on used_pct and reset timer
  - Color thresholds: green (<50%), yellow (50-75%), orange (75-90%), red (>90%)
  - Show "Expired" badge when session has expired
  - Reference Claude-Usage-Tracker layout: session row + weekly row + model rows

  **Must NOT do**:
  - Do NOT add history chart here (that's UsagePage task 11)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: `["frontend-ui-ux"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3, with 11-14)
  - **Blocks**: None
  - **Blocked By**: 4 (quota history endpoint for pace data)

  **References**:
  - `src/dashboard/pages/QuotasPage.tsx` — current implementation
  - `src/dashboard/components/QuotaCard.tsx` — current card component
  - Claude-Usage-Tracker: PopoverContentView.swift session/weekly rows
  - codex-lb: account cards with status badges

  **Acceptance Criteria**:
  ```
  Scenario: Quota cards grouped by account
    Tool: Playwright
    Steps:
      1. Navigate to /dashboard/#/quotas
      2. Verify cards are grouped (e.g. "claude — ino@timetreeapp.com" has session + weekly + sonnet in one group)
    Expected Result: Account groups visible, not flat list
    Evidence: .omo/evidence/task-10-quota-grouped.png

  Scenario: Pace insight shown
    Tool: Playwright
    Steps:
      1. Find a quota card with >0% usage
      2. Verify pace text like "At current pace..." is visible
    Expected Result: Pace insight text present
    Evidence: .omo/evidence/task-10-pace-insight.png
  ```

  **Commit**: YES
  - Message: `feat(dashboard): redesign quota cards with account grouping and pace insights`

- [x] 11. UsagePage: time-series graphs with Recharts

  **What to do**:
  - Add quota trend chart: line chart showing used_pct over time per provider/account
  - Add request/cost trend chart: bar chart showing requests + line overlay for cost
  - Time range selector: 5h, 24h, 7d, 30d buttons
  - Data from `GET /admin/quotas/history` and `GET /admin/usage/trend`
  - Use Recharts `<LineChart>`, `<BarChart>`, `<ResponsiveContainer>`
  - Dark theme compatible (axis colors, tooltip styling)

  **Must NOT do**:
  - Do NOT add more than 2 chart types on the page
  - Do NOT add real-time WebSocket streaming

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: `["frontend-ui-ux"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3)
  - **Blocks**: None
  - **Blocked By**: 4, 5, 9 (both endpoints + recharts)

  **References**:
  - `src/dashboard/pages/UsagePage.tsx` — current implementation
  - Claude-Usage-Tracker: UsageHistoryView.swift 5h/24h/7d/30d zoom
  - codex-lb: 28-day trend charts
  - Recharts docs: LineChart, BarChart, ResponsiveContainer

  **Acceptance Criteria**:
  ```
  Scenario: Graphs render
    Tool: Playwright
    Steps:
      1. Navigate to /dashboard/#/usage
      2. Verify at least one chart with SVG elements is visible
      3. Click different time range buttons (5h, 24h, 7d)
      4. Verify chart updates
    Expected Result: Charts visible with data, time range buttons work
    Evidence: .omo/evidence/task-11-usage-graphs.png
  ```

  **Commit**: YES
  - Message: `feat(dashboard): add usage time-series graphs with Recharts`

- [x] 12. LogsPage: enhanced filters UI

  **What to do**:
  - Add filter dropdowns/inputs for: model (text input), provider (dropdown from known providers), status (dropdown: all/2xx/4xx/5xx), lifecycle (dropdown)
  - Frontend status dropdown maps ranges to backend params: "2xx" sends `status=200` (backend exact match), or extend backend to accept `status_min=200&status_max=299` for range. Decision: use `status_min` + `status_max` params — update backend Task 2 accordingly.
  - Wire to existing `tool` and `client_id` + new `model`, `provider`, `status_min`, `status_max` query params
  - Clear filters button
  - Preserve filter state in URL hash params

  **Must NOT do**:
  - Do NOT add date range filter (separate future work)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: `["frontend-ui-ux"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3)
  - **Blocks**: None
  - **Blocked By**: 2 (log filter backend)

  **References**:
  - `src/dashboard/pages/LogsPage.tsx` — current implementation
  - `src/dashboard/components/LogTable.tsx` — current table
  - codex-lb: recent-requests-table.tsx filter approach

  **Acceptance Criteria**:
  ```
  Scenario: Filter by provider
    Tool: Playwright
    Steps:
      1. Navigate to /dashboard/#/logs
      2. Select provider "openai" from dropdown
      3. Verify table only shows openai rows
    Expected Result: Filter applied, table reflects selection
    Evidence: .omo/evidence/task-12-log-filter.png
  ```

  **Commit**: YES
  - Message: `feat(dashboard): add model, provider, and status filters to logs page`

- [x] 13. ApiKeysPage: new management page

  **What to do**:
  - Create `src/dashboard/pages/ApiKeysPage.tsx`
  - List existing keys: table with name, key_prefix (masked), created, last_used, request_count, revoke button
  - Create key: form with name input, shows full key ONCE in a copyable modal after creation
  - Revoke key: confirmation dialog
  - Per-key usage summary (request count, total tokens, total cost)
  - Add "API Keys" nav link in Layout.tsx sidebar
  - Add route in main.tsx router
  - Add API functions in api.ts

  **Must NOT do**:
  - Do NOT add key editing (name change)
  - Do NOT add key rotation

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: `["frontend-ui-ux"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3)
  - **Blocks**: None
  - **Blocked By**: 7 (API key CRUD endpoints)

  **References**:
  - codex-lb: apis-page.tsx — key management UI pattern
  - `src/dashboard/pages/OAuthPage.tsx` — existing page pattern
  - `src/dashboard/api.ts` — API client pattern

  **Acceptance Criteria**:
  ```
  Scenario: Create and list API key
    Tool: Playwright
    Steps:
      1. Navigate to /dashboard/#/api-keys
      2. Click "Create Key", enter name "test-key", submit
      3. Verify full key is shown in modal (copyable)
      4. Close modal, verify key appears in list with masked prefix
    Expected Result: Key created and visible in list
    Evidence: .omo/evidence/task-13-api-key-create.png

  Scenario: Revoke API key
    Tool: Playwright
    Steps:
      1. Click revoke button on a key
      2. Confirm dialog
      3. Verify key shows "Revoked" status
    Expected Result: Key revoked successfully
    Evidence: .omo/evidence/task-13-api-key-revoke.png
  ```

  **Commit**: YES
  - Message: `feat(dashboard): add API keys management page`

- [x] 14. OAuthPage: improved dialog UX

  **What to do**:
  - Show provider-specific badges with colors (claude=purple, codex=green, kimi=blue, xai=gray)
  - Group accounts by provider
  - Show "Last Refreshed: X ago" with relative time
  - Improve OAuthJobPanel: clearer status steps (Starting → Waiting for URL → Auth URL ready → SSH tunnel needed → Completed/Failed)
  - Add copy-to-clipboard for SSH tunnel command and OAuth URL
  - Reference codex-lb oauth-dialog flow steps

  **Must NOT do**:
  - Do NOT add device code flow (CLIProxyAPI doesn't expose it via subprocess)
  - Do NOT add manual callback URL input

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: `["frontend-ui-ux"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1-6, 9)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `src/dashboard/pages/OAuthPage.tsx` — current implementation
  - `src/dashboard/components/OAuthJobPanel.tsx` — current job panel
  - `src/dashboard/components/AuthAccountList.tsx` — current account list
  - codex-lb: oauth-dialog.tsx — browser/device/manual callback flow

  **Acceptance Criteria**:
  ```
  Scenario: Accounts grouped by provider
    Tool: Playwright
    Steps:
      1. Navigate to /dashboard/#/oauth
      2. Verify accounts are grouped under provider headings
    Expected Result: Provider groups visible (Claude, Codex, Kimi, xAI)
    Evidence: .omo/evidence/task-14-oauth-grouped.png

  Scenario: Copy SSH tunnel command
    Tool: Playwright
    Steps:
      1. Start a login job
      2. When SSH tunnel command appears, click copy button
    Expected Result: Copy button responds (visual feedback)
    Evidence: .omo/evidence/task-14-oauth-copy.png
  ```

  **Commit**: YES
  - Message: `feat(dashboard): improve OAuth dialog UX`

---

## Final Verification Wave

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`
  **Pass criteria**: All Must Have items confirmed present (7/7). Zero Must NOT Have violations found. All 14 task evidence files exist.
  **Fail criteria**: Any Must Have missing OR any Must NOT Have violation found with file:line citation.

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run typecheck` + `bun test` + `bun run build`. Review changed files for: `as any`, empty catches, console.log in prod, commented-out code. Check AI slop: excessive comments, over-abstraction.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`
  **Pass criteria**: typecheck exit 0, bun test 0 new failures, bun run build exit 0, zero `as any`/`@ts-ignore` in changed files.
  **Fail criteria**: Any build/typecheck failure OR new test failure OR forbidden pattern found.

- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from clean state. Test each page: login → quotas (grouped cards, pace) → logs (filters work) → usage (graphs render) → API keys (create/list/revoke) → OAuth. Save screenshots.
  Output: `Scenarios [N/N pass] | VERDICT`
  **Pass criteria**: All 6 pages load without JS errors. Quota cards grouped. Graphs render SVG. Log filters produce correct results. API key create/revoke works. OAuth accounts grouped.
  **Fail criteria**: Any page crashes, any console error (excluding pre-existing), any feature non-functional.

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read spec vs actual diff. Verify 1:1. Check "Must NOT do" compliance. Detect unaccounted changes.
  Output: `Tasks [N/N compliant] | VERDICT`
  **Pass criteria**: All 14 tasks implemented per spec. No files changed outside task scope. All "Must NOT do" items verified absent.
  **Fail criteria**: Any task deviates from spec OR unaccounted file changes detected.

---

## Commit Strategy

- **1**: `fix(server): add allowlist passthrough filter for known API paths`
- **2**: `feat(admin): add model, provider, and status filters to request logs`
- **3**: `feat(storage): add api_keys table and proxy_api_key_id column (migration 008)`
- **4**: `feat(admin): add quota history time-series endpoint`
- **5**: `feat(admin): add request/cost time-series endpoint`
- **6**: `feat(runtime): add quota_snapshots retention cleanup to supervisor`
- **7**: `feat(admin): add API key CRUD endpoints`
- **8**: `feat(server): identify requests by proxy API key`
- **9**: `build: add recharts dependency`
- **10**: `feat(dashboard): redesign quota cards with account grouping and pace insights`
- **11**: `feat(dashboard): add usage time-series graphs with Recharts`
- **12**: `feat(dashboard): add model, provider, and status filters to logs page`
- **13**: `feat(dashboard): add API keys management page`
- **14**: `feat(dashboard): improve OAuth dialog UX`

---

## Success Criteria

### Verification Commands
```bash
bun run typecheck  # Expected: exit 0
bun test           # Expected: all pass (pre-existing ready.test.ts port failures excluded)
bun run build      # Expected: exit 0, dist/dashboard/ contains assets
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Browser noise no longer in logs
- [ ] Quota cards grouped by account with pace insights
- [ ] Usage graphs render with zoom levels
- [ ] API keys: create, list, revoke working
- [ ] Log filters: model, provider, status working
