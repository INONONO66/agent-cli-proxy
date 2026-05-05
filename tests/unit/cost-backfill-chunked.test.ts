import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

process.env.PROXY_LOCAL_OK = "1";
process.env.PRICING_CACHE_PATH = join(tmpdir(), `agent-cli-proxy-cost-backfill-${crypto.randomUUID()}.json`);

const { Config, ConfigError } = await import("../../src/config/validate");
const { Storage } = await import("../../src/storage/db");
const { Pricing } = await import("../../src/storage/pricing");
const { RequestRepo, UsageRepo } = await import("../../src/storage/repo");
const { UsageService } = await import("../../src/storage/service");

const originalFetch = globalThis.fetch;
const unitPrice = { input: 1, output: 1 };

interface AggregateRow {
  day: string;
  provider: string;
  model: string;
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

beforeEach(() => {
  globalThis.fetch = (() => Promise.reject(new Error("use in-memory pricing"))) as unknown as typeof fetch;
  Pricing.__clearPricingForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Pricing.__clearPricingForTests();
  rmSync(process.env.PRICING_CACHE_PATH ?? "", { force: true });
});

test("COST_BACKFILL_CHUNK_SIZE defaults to 500 and requires a positive integer", () => {
  const baseEnv = { CLI_PROXY_API_URL: "http://localhost:8317" };

  expect(Config.validate(baseEnv).costBackfillChunkSize).toBe(500);
  expect(Config.validate({ ...baseEnv, COST_BACKFILL_CHUNK_SIZE: "25" }).costBackfillChunkSize).toBe(25);

  for (const value of ["0", "1.5", "NaN"]) {
    try {
      Config.validate({ ...baseEnv, COST_BACKFILL_CHUNK_SIZE: value });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (!(err instanceof ConfigError)) throw err;
      expect(err.issues).toContainEqual({
        path: "COST_BACKFILL_CHUNK_SIZE",
        message: "must be a positive integer",
      });
      continue;
    }
    throw new Error(`Expected COST_BACKFILL_CHUNK_SIZE=${value} to fail`);
  }
});

test("chunked backfill yields between chunks while updating costs", async () => {
  Pricing.__setPricingForTests([]);
  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);

  for (let index = 0; index < 20; index += 1) {
    await recordCompletedUsage(service, {
      requestId: `yield-${index}`,
      model: "gpt-5-yield-later",
      promptTokens: 1_000_000,
      startedAt: `2026-05-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    });
  }

  Pricing.__setPricingForTests([["openai/gpt-5-yield-later", unitPrice]]);

  let ticks = 0;
  const interval = setInterval(() => {
    ticks += 1;
  }, 0);

  try {
    const result = await service.backfillCosts({ all: true, chunkSize: 2 });
    expect(result).toEqual({ scanned: 20, updated: 20, ok: 20, pending: 0, unsupported: 0 });
  } finally {
    clearInterval(interval);
    db.close();
  }

  expect(ticks).toBeGreaterThanOrEqual(2);
});

test("chunked backfill keeps daily_usage aligned with completed and error logs", async () => {
  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);

  Pricing.__setPricingForTests([["openai/gpt-5-steady", unitPrice]]);
  await recordCompletedUsage(service, {
    requestId: "steady-cost",
    model: "gpt-5-steady",
    promptTokens: 2_000_000,
    startedAt: "2026-05-01T01:00:00.000Z",
  });
  const steadyBefore = UsageRepo.getDaily(db, "2026-05-01").find((row) => row.model === "gpt-5-steady");

  Pricing.__setPricingForTests([]);
  for (let index = 0; index < 12; index += 1) {
    await recordCompletedUsage(service, {
      requestId: `aggregate-${index}`,
      model: "gpt-5-backfill-later",
      promptTokens: 1_000_000,
      startedAt: `2026-05-01T02:00:${String(index).padStart(2, "0")}.000Z`,
    });
  }

  Pricing.__setPricingForTests([["openai/gpt-5-backfill-later", unitPrice]]);
  const result = await service.backfillCosts({ all: true, chunkSize: 5 });
  const steadyAfter = UsageRepo.getDaily(db, "2026-05-01").find((row) => row.model === "gpt-5-steady");
  const dailyRows = UsageRepo.getRange(db, "2026-05-01", "2026-05-01");
  const logRows = aggregateRequestLogs(db);

  expect(result).toEqual({ scanned: 12, updated: 12, ok: 12, pending: 0, unsupported: 0 });
  expect(steadyAfter).toEqual(steadyBefore);
  expect(toComparableDailyRows(dailyRows)).toEqual(toComparableDailyRows(logRows));
  db.close();
});

test("backfill scans unresolved candidates once when pricing cannot resolve them", async () => {
  Pricing.__setPricingForTests([]);
  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);

  for (let index = 0; index < 3; index += 1) {
    insertBackfillCandidate(db, {
      requestId: `pending-${index}`,
      model: `gpt-5-unpriced-${index}`,
      startedAt: `2026-05-02T00:00:0${index}.000Z`,
    });
  }
  for (let index = 0; index < 3; index += 1) {
    insertBackfillCandidate(db, {
      requestId: `unsupported-${index}`,
      model: "unknown",
      startedAt: `2026-05-02T00:00:1${index}.000Z`,
    });
  }

  const result = await service.backfillCosts({ all: true, chunkSize: 2 });
  const auditRows = db.query("SELECT request_log_id FROM cost_audit ORDER BY request_log_id").all();

  expect(result).toEqual({ scanned: 6, updated: 0, ok: 0, pending: 3, unsupported: 3 });
  expect(auditRows).toHaveLength(6);
  db.close();
});

async function recordCompletedUsage(
  service: ReturnType<typeof UsageService.create>,
  options: { requestId: string; model: string; promptTokens: number; startedAt: string },
): Promise<number> {
  return service.recordUsage({
    request_id: options.requestId,
    provider: "openai",
    model: options.model,
    tool: "opencode",
    client_id: "local",
    path: "/v1/chat/completions",
    streamed: 0,
    status: 200,
    prompt_tokens: options.promptTokens,
    completion_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: options.promptTokens,
    cost_usd: 0,
    incomplete: 0,
    started_at: options.startedAt,
    finished_at: options.startedAt,
  });
}

function insertBackfillCandidate(
  db: ReturnType<typeof Storage.initDb>,
  options: { requestId: string; model: string; startedAt: string },
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
    started_at: options.startedAt,
    finished_at: options.startedAt,
  });
}

function aggregateRequestLogs(db: ReturnType<typeof Storage.initDb>): AggregateRow[] {
  return db.query(`
    SELECT
      substr(started_at, 1, 10) AS day,
      provider,
      model,
      COUNT(*) AS request_count,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd
    FROM request_logs
    WHERE lifecycle_status IN ('completed', 'error')
    GROUP BY substr(started_at, 1, 10), provider, model
    ORDER BY day, provider, model
  `).all() as AggregateRow[];
}

function toComparableDailyRows(rows: AggregateRow[]): AggregateRow[] {
  return rows
    .map((row) => ({
      day: row.day,
      provider: row.provider,
      model: row.model,
      request_count: row.request_count,
      prompt_tokens: row.prompt_tokens,
      completion_tokens: row.completion_tokens,
      cache_creation_tokens: row.cache_creation_tokens,
      cache_read_tokens: row.cache_read_tokens,
      total_tokens: row.total_tokens,
      cost_usd: row.cost_usd,
    }))
    .sort((left, right) => `${left.day}/${left.provider}/${left.model}`.localeCompare(`${right.day}/${right.provider}/${right.model}`));
}
