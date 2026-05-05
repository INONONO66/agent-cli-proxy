# T1 Scope Creep Correction (May 4, 2026, 22:35 UTC)

## Issue
Initial T1 execution included out-of-scope changes to source code, tests, and package configuration:
- Modified: `package.json`, `src/cli.ts`, `src/config/index.ts`, `src/server/handler.ts`, `src/server/pass-through.ts`, `src/server/request-inspector.ts`, `src/storage/db.ts`, `test-inspector.ts`, `tests/e2e/mockCliProxyApi.ts`, `tests/e2e/proxy.test.ts`
- Created: `src/provider/registry.ts` (untracked)

## Root Cause
T1 scope is explicitly "repo/docs cleanup only" — no source code, test, or package changes. The initial execution violated this constraint by implementing features that belong to T2-T20 (logger, config, provider registry, lifecycle, tests, packaging).

## Resolution
Reverted all out-of-scope changes using `git checkout --` on modified files and `rm -f` on untracked source files. Preserved legitimate T1 changes:
- Deleted: `Dockerfile`, `docker-compose.yml`, `.dockerignore` (from git tracking)
- Modified: `LICENSE` (copyright to "Agent CLI Proxy contributors"), `README.md` (verified bunx/systemd/launchd paths)
- Created: `CONTRIBUTING.md`, `SECURITY.md` (placeholder docs)

## Verification
- `git diff --stat -- ':!node_modules'` shows only `LICENSE` and `README.md` changes ✓
- `git ls-files | grep -Ei 'docker'` returns empty (exit 1) ✓
- `git grep -ni 'docker' -- ':!.sisyphus' ':!.git' ':!node_modules'` returns empty (exit 1) ✓
- Untracked files: `.sisyphus/`, `CONTRIBUTING.md`, `SECURITY.md` (all allowed) ✓

## Lesson Learned
T1 is a **repo/docs-only task**. Future tasks (T2-T20) will handle:
- Logger implementation (T2)
- Config/environment management (T3)
- Provider registry (T4)
- Lifecycle/graceful shutdown (T5)
- Test infrastructure (T6-T10)
- Package/release workflow (T18-T20)

Do not pre-implement future tasks while fixing current task scope violations.

---

# Code Quality Backlog from May 2 main commits (logged 2026-05-05)

Oracle audit (session ses_20a8ea9deffeDODKDgSG1UOQWC) of recent main work that lives outside this plan: dashboard removal, installer CLI, account attribution + quota probes, runtime pricing fetch, new pass-through architecture, SSE usage parsing fix.

## Status legend
- [T8] Will be addressed during plan T8 (pre-log + finalize lifecycle).
- [T9] Naturally folded into plan T9 (strict cost mode).
- [LATER] Out of plan scope; revisit after T1-T20 complete.

## HIGH

- [T8] **pass-through.ts:58-67** — Forwarded headers keep stale `content-length` / `content-encoding` after `buildBody()` rewrites Anthropic JSON. Risk: upstream hangs, truncation, malformed requests.
  Fix sketch: drop `content-length`, `content-encoding`, optionally `accept-encoding`; force `content-type: application/json` for rewritten bodies.

- [T8] **pass-through.ts:132-150** — Streaming `flush()` parses `partialLine` but never enqueues; final SSE event without trailing newline can be lost. Also calls async `logUsage()` without `await`/catch.
  Fix sketch: reuse normal line-processing path for `partialLine + "\n"`, enqueue, make `flush` async, await + catch.

- [LATER] **cliproxy/correlator.ts:107-108 + storage/repo.ts:105-123 + storage/service.ts:234-252** — `setInterval()` ticks can overlap and double-count `daily_account_usage`. `applyCorrelation()` increments aggregate even when row already correlated.
  Fix sketch: in-flight guard; `UPDATE ... WHERE id=? AND cliproxy_account IS NULL`; only upsert aggregates on actual change. Plan T11 supervisor will replace bare setInterval; consider folding the WHERE-clause + change-count guard into T11 work.

- [LATER] **server/pass-through.ts:192-214 + server/request-inspector.ts:1-12 + cliproxy/correlator.ts:20-36** — Pass-through never persists a stable `request_id`; correlator matches by timestamp/model/token/latency heuristics. Under load, similar requests can be attributed to the wrong account.
  Fix sketch: capture/forward stable request id from inbound headers or generate one (uuid v7); prefer exact request id from CLIProxyAPI Management API; skip ambiguous heuristic matches. Plan T8 introduces a `request_id`; T10 subscription wiring + later correlator hardening can tighten attribution.

- [LATER] **storage/db.ts:14-26 + db.ts:67-72** — Migration runner suppresses broad errors (`no such column`, `syntax error`) and still records the migration as applied. Permanently hides schema drift.
  Fix sketch: only ignore known duplicate-column cases for specific statements; otherwise re-throw. Add post-migration schema assertions before inserting `schema_migrations`.

## MEDIUM

- [T9] **server/response-parser.ts:115-125 + pass-through.ts:166-178** — Anthropic SSE usage blindly summed across chunks; `message_start` output_tokens + `message_delta` output_tokens can over-count totals.
  Fix sketch: provider-specific accumulation; `message_start` captures input/cache only; `message_delta` finalizes/replaces output totals.

- [LATER] **storage/db.ts:126-141 + repo.ts:163-180** — `daily_account_usage` PK omits `cliproxy_auth_index`, but later queries group by it. Same account label across auth indexes collapses to one row.

- [T9] **storage/pricing.ts:155-166** — First fetch failure with no disk cache caches local-only fallback as fresh for full TTL; most models stay unpriced until TTL expires.
  Fix sketch: mark fallback caches separately or use a short retry TTL; keep `fetchedAt` stale so normal calls retry soon.

- [T9] **storage/pricing.ts:257-260** — Broad substring fuzzy matching can select an unrelated model's pricing. Silent cost miscalculation risk.
  Fix sketch: require exact, normalized, alias, or provider-scoped suffix matches; remove broad `includes` fallback.

- [LATER] **cliproxy/quota.ts:389-403 + 412-418** — Missing/unreadable auth dir fails before per-file error handling; disabled auth files still probed.
  Fix sketch: catch `readdir` errors and return empty/error report; skip network probes for `disabled: true`.

- [LATER] **admin/index.ts:16-21, 42-47, 50-56** — Date params only checked for presence, not format/range. Invalid strings flow into SQLite range queries.
  Fix sketch: validate `YYYY-MM-DD`, reject invalid dates, enforce `from <= to`.

- ~~[T14] **cli.ts:107-112, 280-288** — `init` always overwrites target `.env` including secrets without merge/backup/confirmation. Not idempotent.~~ RESOLVED in T14: `.env` writes now refuse existing files unless `--force` or `--merge`, preserve existing values on merge, and use temp-file + rename with mode `0600`.

## LOW

- ~~[T14] **cli.ts:377-382** — `getArg()` accepts another flag as a value (e.g. `--env --runtime-dir foo`).~~ RESOLVED in T14: centralized `parseArgs()`/`getFlagValue()` rejects flag-looking values for required-value flags.
- ~~[T14] **cli.ts:321-323** — In non-TTY mode, `askSecret()` falls back to normal prompting; secrets can echo in logs.~~ RESOLVED in T14: non-TTY secret prompts now fail and direct users to env-backed non-interactive flags.
- [LATER] **server/handler.ts:32-34 + admin/index.ts:105-109** — Admin misses return plain-text `Not Found`; admin errors otherwise return JSON.

## RESOLVED

- [T14] CLI init/env idempotency, argv parsing, and non-TTY secret prompting resolved during Task 14 CLI hardening. Evidence: `.sisyphus/evidence/task-14-doctor-fail.txt`, `.sisyphus/evidence/task-14-plans-roundtrip.txt`.

## Decision

This session executes ONLY HIGH-1 and HIGH-2 inside Plan T8. All other items are tracked here and routed to their natural Plan task or `[LATER]`.
