
## 2026-05-08 - cost backfill race
- Replaced daily_usage rebuild in cost backfill with per-row cost delta upserts.
- Targeted verification passed: bun run typecheck, cost-backfill-race, cost-backfill-chunked.
- Full bun test currently fails outside this task in tests/unit/storage-lifecycle-cost.test.ts because hardcoded 2026-05-04 logs are older than the 200000000 ms uncorrelated window on 2026-05-08.
