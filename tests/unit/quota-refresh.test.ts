import { afterEach, expect, spyOn, test } from "bun:test";
import type { Usage } from "../../src/usage";

let refreshSpy: { mockRestore(): void } | null = null;

afterEach(() => {
  refreshSpy?.mockRestore();
  refreshSpy = null;
});

function quotaResult(timestamp: string): Usage.QuotaRefreshResult {
  return {
    timestamp,
    inserted: 0,
    accounts: [{
      provider: "claude",
      account: "acct@example.com",
      status: "ok",
      unavailable: false,
      disabled: false,
      refreshed_at: timestamp,
      windows: [{
        timestamp,
        provider: "claude",
        account: "acct@example.com",
        quota_type: "five_hour",
        model: null,
        used_pct: 10,
        remaining: 90,
        remaining_raw: "90.00%",
        resets_at: null,
        raw_json: "{}",
      }],
      local_usage: {
        five_hour: { since: "", requests: 0, total_tokens: 0, cost_usd: 0 },
        seven_day: { since: "", requests: 0, total_tokens: 0, cost_usd: 0 },
      },
    }],
  };
}

test("quota refresh shares an in-flight probe", async () => {
  process.env.PROXY_LOCAL_OK = "1";
  const { QuotaProbe } = await import("../../src/cliproxy/quota");
  const { Storage } = await import("../../src/storage/db");
  const { QuotaRepo } = await import("../../src/storage/repo");
  const { UsageService } = await import("../../src/storage/service");
  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);
  QuotaRepo.insertSnapshot(db, {
    timestamp: "2000-01-01T00:00:00.000Z",
    provider: "claude",
    account: "acct@example.com",
    quota_type: "seven_day",
    model: null,
    used_pct: 90,
    remaining: 10,
    remaining_raw: "10.00%",
    resets_at: null,
    raw_json: "{}",
  });
  let releaseProbe!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const refreshedAt = new Date().toISOString();
  refreshSpy = spyOn(QuotaProbe, "refresh").mockImplementation(async () => {
    await gate;
    return quotaResult(refreshedAt);
  });

  const first = service.refreshQuotas();
  const second = service.refreshQuotas();
  expect(refreshSpy).toHaveBeenCalledTimes(1);
  releaseProbe();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  expect(firstResult.inserted).toBe(1);
  expect(secondResult).toBe(firstResult);
  expect(QuotaRepo.getLatest(db)).toHaveLength(1);
  db.close();
});
