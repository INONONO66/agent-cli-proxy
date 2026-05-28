# Dashboard/admin auth validation

Validation date: 2026-05-28
Base branch: `main`

## Summary

This change fixes dashboard/admin 403 handling and reverse-proxy HTTPS decisions without changing API contracts or the database schema. Browser login now receives actionable auth errors, token-authenticated admin API calls avoid cookie-only CSRF requirements, and forwarded headers are ignored unless explicitly trusted.

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript | PASS | `bun run typecheck` |
| Focused auth/security tests | PASS | `bun test tests/unit/session.test.ts tests/unit/config-dashboard.test.ts tests/unit/dashboard-api.test.ts tests/unit/security-headers.test.ts tests/e2e/admin-auth.test.ts tests/unit/lifecycle.test.ts` => 31 pass, 0 fail |
| Full default test suite | PASS | `CLI_PROXY_API_URL=http://localhost:8317 bun test` => 195 pass, 22 skipped, 0 fail |

## Covered behavior

- `/admin/session/login` returns a structured `LOGIN_NOT_CONFIGURED` response when dashboard password login is disabled.
- Dashboard API clients preserve 401/403 status and auth error code instead of collapsing every auth failure into a generic unauthorized error.
- Admin API key requests may perform mutations without CSRF headers; browser session cookies still require `x-csrf: 1` for unsafe methods.
- HSTS and `Secure` session cookies depend on direct HTTPS, or on forwarded/Cloudflare HTTPS headers only when `TRUST_PROXY_HEADERS=true`.
- Client-supplied forwarding headers are stripped before upstream proxying and are not logged as source IPs unless proxy headers are trusted.
