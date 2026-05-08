# hardening-race-memory Issues

## Active Blockers
None yet.

## Resolved

## Notes
- Each PR must merge cleanly against main.
- Do NOT push main without user approval.

## 2026-05-08 — breaker eviction (#16)
- `CircuitBreaker` now tracks `lastActivity` to enable stale entry eviction.
- Eviction scan runs at most once per 60s, only removing closed breakers with 0 failures that have been inactive for 5 minutes (`BREAKER_EVICT_AFTER_MS = 300_000`).
- Open and half-open breakers are never evicted.
- Added `__getBreakerCountForTests()` for deterministic breaker Map inspection.
- `bun run typecheck` and `bun test tests/unit/breaker-eviction.test.ts` both pass.

## 2026-05-08 — response body cap (#33)
- Added `MAX_RESPONSE_BODY_BYTES = 52_428_800` (50 MB) constant in `src/server/pass-through.ts`.
- `readBodyCapped()` checks `Content-Length` header first (fast path), then falls back to chunked stream reading.
- When cap exceeded: logs `passthrough.response_body_too_large`, finalizes with `lifecycle_status='error'` / `errorCode='response_too_large'`, returns 502 proxy error.
- Normal responses under cap pass through unchanged.
- `bun run typecheck` and `bun test tests/unit/response-body-cap.test.ts` both pass.

## fix/warning-map-leak

- Map key format: `${cliproxyAccount}:${day}` where day is ISO date slice(0,10)
- Lazy pruning at start of `warnUnmappedSubscription` — no timer/interval needed
- Exported `unmappedSubscriptionWarnings` for direct test manipulation
- Tests require `PROXY_LOCAL_OK=1` because importing `src/storage/service.ts` triggers config validation via module-level imports

## 2026-05-08 - cost backfill race
- Replaced daily_usage rebuild in cost backfill with per-row cost delta upserts.
- Targeted verification passed: bun run typecheck, cost-backfill-race, cost-backfill-chunked.
- Full bun test currently fails outside this task in tests/unit/storage-lifecycle-cost.test.ts because hardcoded 2026-05-04 logs are older than the 200000000 ms uncorrelated window on 2026-05-08.
