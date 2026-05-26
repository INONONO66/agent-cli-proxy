# Learnings — dashboard-v2

## [2026-05-26] Session ses_19b3c24f3ffe8lB81PCa0LRAJn — Init

### Project Conventions
- Runtime: Bun. No node/npm/pnpm/vite/ts-node.
- Server: `Bun.serve()`. No express/hono.
- SQLite: `bun:sqlite`. No better-sqlite3.
- Tests: `bun test`. No vitest/jest.
- File IO: `Bun.file()` preferred.
- No `as any` / `@ts-ignore` / `@ts-expect-error`.
- No empty catch blocks.
- Comments: WHY only, not WHAT.
- No banner comments (// ----, // ====).
- No numbered step comments.

### Code Layout
- `src/server/handler.ts` — HTTP handler, passthrough routing
- `src/storage/repo.ts` — RequestRepo, QuotaRepo namespaces
- `src/storage/migrations/` — numbered SQL files (immutable once merged)
- `src/admin/index.ts` — admin API routes
- `src/runtime/supervisor.ts` — background loop registration
- `src/dashboard/pages/` — React SPA pages
- `src/dashboard/components/` — shared components
- `src/dashboard/api.ts` — API client

### Dashboard Architecture
- React SPA at `/dashboard/*`
- Cookie session auth + bearer token dual auth
- Hash-based routing (URL hash params for filter state)
- Dark theme

### Key Patterns
- Repo pattern: prepared statements, namespace exports (see `src/storage/repo.ts`)
- Admin endpoint pattern: see `src/admin/oauth.ts`
- Migration naming: `00N_description.sql` (immutable once merged)
- Loop registration: see `src/runtime/supervisor.ts`

## [2026-05-27] Session task-2 — Request log filters

### Request Log Filtering
- `RequestRepo.getRecent()` now accepts exact-match `model`, `provider`, and `lifecycle_status` filters plus `status_min`/`status_max` range bounds.
- Filters are appended as parameterized `AND` clauses so the log query stays injection-safe.
- `/admin/logs` now reads `model`, `provider`, `status_min`, `status_max`, and `lifecycle_status` from query params and returns the same response shape.

### 2026-05-26 — Path allowlist passthrough guard
- `src/server/handler.ts` now rejects non-reserved, non-API paths with `404 {"error":"not found"}`.
- Allowlist is hardcoded to `/v1/` and `/api/` prefixes only.
- Reserved routes above the passthrough block stay unchanged (`/health`, `/ready`, `/metrics`, `/dashboard/*`, `/admin/*`).

### 2026-05-26 — Migration 008 api key schema
- Added `src/storage/migrations/008_api_keys.sql` with `api_keys` and `request_logs.proxy_api_key_id`.
- Migration stays schema-only: no plaintext key storage, no indexes on `request_logs`.

### 2026-05-27 — Quota history time-series endpoint
- `QuotaRepo.getHistory(db, { hours, provider?, account? })` buckets `quota_snapshots` with SQLite `strftime()` and returns aligned empty buckets.
- `/admin/quotas/history` defaults to 24h, accepts optional `provider` and `account`, and wraps the repo result as `{ buckets: [...] }`.
- Bucket sizes follow the dashboard zoom levels: 5m for ≤5h, 1h for ≤24h, 4h for ≤7d, 1d for ≤30d.

### 2026-05-26 — Quota retention cleanup
- Added `QuotaRepo.deleteOlderThan30Days(db)` to delete `quota_snapshots` rows older than 30 days using SQLite `datetime('now', '-30 days')`.
- Added a `quota-retention` supervisor loop helper with a 24h interval and `quota.retention_cleanup` info logging for deleted rows.

### 2026-05-26 — Recharts dependency
- Installed `recharts@3.8.1` with `bun add recharts`.
- Bun also added matching React packages and lockfile entries for the dashboard build.

### 2026-05-26 — Usage trend endpoint
- `GET /admin/usage/trend` aggregates `request_logs` into UTC buckets with `requests`, `tokens`, and `cost_usd` totals.
- Bucket size auto-scales by requested window: 5m, 1h, 4h, then 1d.
- Optional filters are applied directly in SQL for `provider`, `model`, and `tool`.

### 2026-05-26 — OAuth dialog UX improvements
- `AuthAccountList`: accounts now grouped by provider with provider heading + account count.
- Provider badges use data-driven color mapping (`claude=purple`, `codex=green`, `kimi=blue`, `xai=gray`) via `PROVIDER_COLORS` const.
- "Last Refreshed: X ago" uses `Date.now()` relative time (s/m/h/d).
- `OAuthJobPanel`: added visual status step progression (Starting → Waiting for URL → Auth URL ready → SSH tunnel needed → Completed/Failed).
- Copy-to-clipboard buttons for both OAuth URL and SSH tunnel command with `navigator.clipboard.writeText()` + "Copied!" feedback via `useState`.

### 2026-05-27 — API key repository and admin routes
- `ApiKeyRepo.create()` generates a 32-byte hex key, stores only a SHA-256 hash, and returns the full key only in the create response.
- `ApiKeyRepo.list()` exposes `keyPrefix` plus usage count from `request_logs.proxy_api_key_id`, never the full key or hash.
- `/admin/api-keys` routes live in `src/admin/api-keys.ts`; POST and DELETE require `x-csrf: 1` even when bearer-token auth is used.
- Per-key usage endpoint returns `{ id, requestCount, totalTokens, totalCostUsd }` from `request_logs` aggregates.
