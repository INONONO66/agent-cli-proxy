import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

process.env.PROXY_LOCAL_OK = "1";
process.env.PRICING_CACHE_PATH = join(tmpdir(), `cost-backfill-account-${crypto.randomUUID()}.json`);

const { Storage } = await import("../../src/storage/db");
const { Pricing } = await import("../../src/storage/pricing");
const { RequestRepo, UsageRepo } = await import("../../src/storage/repo");
const { UsageService } = await import("../../src/storage/service");

const originalFetch = globalThis.fetch;
const unitPrice = { input: 1, output: 1 };

beforeEach(() => {
  function rejectFetch(_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> {
    return Promise.reject(new Error("use in-memory pricing"));
  }
  rejectFetch.preconnect = originalFetch.preconnect;
  globalThis.fetch = rejectFetch;
  Pricing.__clearPricingForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Pricing.__clearPricingForTests();
  rmSync(process.env.PRICING_CACHE_PATH ?? "", { force: true });
});

test("cost backfill applies cost deltas to account daily usage", async () => {
  Pricing.__setPricingForTests([["openai/gpt-5-account-backfill", unitPrice]]);
  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);

  try {
    insertAccountRequestLog(db);
    UsageRepo.upsertDaily(db, {
      day: "2026-05-06",
      provider: "openai",
      model: "gpt-5-account-backfill",
      request_count: 1,
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 1_000_000,
      cost_usd: 0,
    });
    UsageRepo.upsertDailyAccount(db, {
      day: "2026-05-06",
      provider: "openai",
      model: "gpt-5-account-backfill",
      cliproxy_account: "acct-primary",
      cliproxy_auth_index: "auth-1",
      request_count: 1,
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 1_000_000,
      cost_usd: 0,
    });

    const result = await service.backfillCosts({ all: true });

    expect(result).toEqual({ scanned: 1, updated: 1, ok: 1, pending: 0, unsupported: 0 });
    expect(sumCost(db, "request_logs")).toBeCloseTo(1, 10);
    expect(sumCost(db, "daily_usage")).toBeCloseTo(1, 10);
    expect(sumCost(db, "daily_account_usage")).toBeCloseTo(1, 10);
  } finally {
    db.close();
  }
});

function insertAccountRequestLog(db: Database): number {
  const id = RequestRepo.insert(db, {
    request_id: "account-backfill-candidate",
    provider: "openai",
    model: "gpt-5-account-backfill",
    tool: "opencode",
    client_id: "local",
    path: "/v1/chat/completions",
    streamed: 0,
    status: 200,
    lifecycle_status: "completed",
    cost_status: "pending",
    prompt_tokens: 1_000_000,
    completion_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 1_000_000,
    cost_usd: 0,
    incomplete: 0,
    started_at: "2026-05-06T00:00:00.000Z",
    finished_at: "2026-05-06T00:00:01.000Z",
  });
  RequestRepo.applyCorrelation(db, id, {
    cliproxy_account: "acct-primary",
    cliproxy_auth_index: "auth-1",
  });
  return id;
}

function sumCost(db: Database, table: "request_logs" | "daily_usage" | "daily_account_usage"): number {
  const row = db.query(`SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd FROM ${table}`).get() as { cost_usd: number };
  return row.cost_usd;
}
