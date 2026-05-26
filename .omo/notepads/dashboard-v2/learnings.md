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

### 2026-05-26 — Path allowlist passthrough guard
- `src/server/handler.ts` now rejects non-reserved, non-API paths with `404 {"error":"not found"}`.
- Allowlist is hardcoded to `/v1/` and `/api/` prefixes only.
- Reserved routes above the passthrough block stay unchanged (`/health`, `/ready`, `/metrics`, `/dashboard/*`, `/admin/*`).

### 2026-05-26 — Migration 008 api key schema
- Added `src/storage/migrations/008_api_keys.sql` with `api_keys` and `request_logs.proxy_api_key_id`.
- Migration stays schema-only: no plaintext key storage, no indexes on `request_logs`.

### 2026-05-26 — Recharts dependency
- Installed `recharts@3.8.1` with `bun add recharts`.
- Bun also added matching React packages and lockfile entries for the dashboard build.
