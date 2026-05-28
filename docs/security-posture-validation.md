# Security Posture Validation

This change tightens default security posture without changing API response bodies,
adding database migrations, or introducing new runtime dependencies.

## Covered behavior

- Security headers are applied to proxied `/v1/*` and `/api/*` responses as well as dashboard/admin/health responses.
- `/metrics` requires existing admin authorization when the service is exposed off loopback; loopback development remains allowed by the existing admin-auth fallback.
- Security-sensitive boolean config values fail fast on typos instead of silently becoming `false`.
- Placeholder secrets emit configuration warnings, including the default upstream proxy key when used with a non-loopback upstream URL.
- Generated dashboard session secrets are written with owner-only file permissions on POSIX platforms.
- Structured logs redact sensitive substrings embedded in `Error` messages/stacks, including bearer tokens, API-key labels, and cookie headers.
- Admin API-key and dashboard session JSON responses include `Cache-Control: no-store`.
- Public security reporting docs no longer include placeholder owner/contact values.

## Explicitly deferred

Full managed proxy API-key validation for public LLM requests is intentionally left
for the dedicated public-deployment API-key story because it changes request auth
semantics for clients that currently pass upstream-style `Authorization` or
`x-api-key` headers.

## Validation

- `bun test tests/unit/config.test.ts tests/unit/logger.test.ts tests/unit/session.test.ts tests/unit/security-headers.test.ts tests/e2e/admin-auth.test.ts`
- `bun run release-check`
