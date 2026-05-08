import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PROXY_LOCAL_OK = "1";
process.env.PRICING_CACHE_PATH = join(tmpdir(), `agent-cli-proxy-cost-backfill-race-${crypto.randomUUID()}.json`);

const { Storage } = await import("../../src/storage/db");
const { Pricing } = await import("../../src/storage/pricing");
const { RequestRepo, UsageRepo } = await import("../../src/storage/repo");
const { UsageService } = await import("../../src/storage/service");

const originalFetch = globalThis.fetch;
const unitPrice = { input: 1, output: 1 };

beforeEach(() => {
  globalThis.fetch = (() => Promise.reject(new Error("use in-memory pricing"))) as unknown as typeof fetch;
  Pricing.__clearPricingForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Pricing.__clearPricingForTests();
  rmSync(process.env.PRICING_CACHE_PATH ?? "", { force: true });
});

test("cost backfill preserves live daily deltas while filling zero-cost rows", async () => {
  Pricing.__setPricingForTests([["openai/gpt-5-delta-later", unitPrice]]);
  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);

  try {
    for (let index = 0; index < 10; index += 1) {
      insertRequestLog(db, {
        requestId: `zero-cost-${index}`,
        model: "gpt-5-delta-later",
        lifecycleStatus: "completed",
        costStatus: "pending",
        promptTokens: 1_000_000,
        costUsd: 0,
        startedAt: `2026-05-03T00:00:${String(index).padStart(2, "0")}.000Z`,
      });
    }

    UsageRepo.upsertDaily(db, {
      day: "2026-05-03",
      provider: "openai",
      model: "gpt-5-delta-later",
      request_count: 10,
      prompt_tokens: 10_000_000,
      completion_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 10_000_000,
      cost_usd: 0,
    });

    insertRequestLog(db, {
      requestId: "live-finalize-delta",
      model: "gpt-5-delta-later",
      lifecycleStatus: "pending",
      costStatus: "ok",
      promptTokens: 0,
      costUsd: 0.75,
      startedAt: "2026-05-03T00:01:00.000Z",
    });
    UsageRepo.upsertDaily(db, {
      day: "2026-05-03",
      provider: "openai",
      model: "gpt-5-delta-later",
      request_count: 1,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      cost_usd: 0.75,
    });

    const result = await service.backfillCosts({ all: true, chunkSize: 4 });

    expect(result).toEqual({ scanned: 10, updated: 10, ok: 10, pending: 0, unsupported: 0 });
    expect(sumDailyCost(db)).toBeCloseTo(sumRequestLogCost(db), 10);
  } finally {
    db.close();
  }
});

test("cost backfill adds only the recomputed cost delta", async () => {
  Pricing.__setPricingForTests([["openai/gpt-5-reprice", unitPrice]]);
  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);

  try {
    insertRequestLog(db, {
      requestId: "reprice-candidate",
      model: "gpt-5-reprice",
      lifecycleStatus: "completed",
      costStatus: "pending",
      promptTokens: 50_000,
      costUsd: 0.03,
      startedAt: "2026-05-04T00:00:00.000Z",
    });
    UsageRepo.upsertDaily(db, {
      day: "2026-05-04",
      provider: "openai",
      model: "gpt-5-reprice",
      request_count: 1,
      prompt_tokens: 50_000,
      completion_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 50_000,
      cost_usd: 0.03,
    });

    insertRequestLog(db, {
      requestId: "live-reprice-delta",
      model: "gpt-5-reprice",
      lifecycleStatus: "pending",
      costStatus: "ok",
      promptTokens: 0,
      costUsd: 0.7,
      startedAt: "2026-05-04T00:01:00.000Z",
    });
    UsageRepo.upsertDaily(db, {
      day: "2026-05-04",
      provider: "openai",
      model: "gpt-5-reprice",
      request_count: 1,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      cost_usd: 0.7,
    });

    const before = sumDailyCost(db);
    const result = await service.backfillCosts({ all: true, chunkSize: 10 });
    const after = sumDailyCost(db);

    expect(result).toEqual({ scanned: 1, updated: 1, ok: 1, pending: 0, unsupported: 0 });
    expect(after - before).toBeCloseTo(0.02, 10);
    expect(after).toBeCloseTo(0.75, 10);
    expect(sumDailyCost(db)).toBeCloseTo(sumRequestLogCost(db), 10);
  } finally {
    db.close();
  }
});

function insertRequestLog(
  db: ReturnType<typeof Storage.initDb>,
  options: {
    requestId: string;
    model: string;
    lifecycleStatus: "pending" | "completed";
    costStatus: "pending" | "ok";
    promptTokens: number;
    costUsd: number;
    startedAt: string;
  },
): number {
  return RequestRepo.insert(db, {
    request_id: options.requestId,
    provider: "openai",
    model: options.model,
    tool: "opencode",
    client_id: "local",
    path: "/v1/chat/completions",
    streamed: 0,
    status: 200,
    lifecycle_status: options.lifecycleStatus,
    cost_status: options.costStatus,
    prompt_tokens: options.promptTokens,
    completion_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: options.promptTokens,
    cost_usd: options.costUsd,
    incomplete: 0,
    started_at: options.startedAt,
    finished_at: options.startedAt,
  });
}

function sumDailyCost(db: ReturnType<typeof Storage.initDb>): number {
  const row = db.query("SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd FROM daily_usage").get() as { cost_usd: number };
  return row.cost_usd;
}

function sumRequestLogCost(db: ReturnType<typeof Storage.initDb>): number {
  const row = db.query("SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd FROM request_logs").get() as { cost_usd: number };
  return row.cost_usd;
}
