import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Usage } from "../../src/usage";

process.env.PROXY_LOCAL_OK = "1";
process.env.PRICING_CACHE_PATH = join(tmpdir(), `agent-cli-proxy-backfill-finalize-${crypto.randomUUID()}.json`);

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
  Pricing.__clearPricingForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Pricing.__clearPricingForTests();
  rmSync(process.env.PRICING_CACHE_PATH ?? "", { force: true });
});

test("backfill skips overlapping runs while one is already in flight", async () => {
  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);
  const overlappingService = UsageService.create(db);
  Pricing.__setPricingForTests([["openai/gpt-5-race", unitPrice]]);
  insertBackfillCandidate(db, {
    requestId: "single-flight-candidate",
    model: "gpt-5-race",
    startedAt: "2026-05-03T00:00:00.000Z",
  });

  let releaseFetch: () => void = () => undefined;
  const fetchStarted = new Promise<void>((resolve) => {
    replaceFetch(async () => {
      resolve();
      await new Promise<void>((release) => {
        releaseFetch = release;
      });
      throw new Error("use in-memory pricing");
    });
  });

  const first = service.backfillCosts({ all: true });
  await fetchStarted;
  const second = await overlappingService.backfillCosts({ all: true });
  releaseFetch();

  expect(second).toEqual({ scanned: 0, updated: 0, ok: 0, pending: 0, unsupported: 0 });
  expect(await first).toEqual({ scanned: 1, updated: 1, ok: 1, pending: 0, unsupported: 0 });
  db.close();
});

test("live finalize during backfill keeps daily_usage aligned with request_logs", async () => {
  replaceFetch(async () => {
    throw new Error("use in-memory pricing");
  });
  Pricing.__setPricingForTests([["openai/gpt-5-race", unitPrice]]);

  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);
  for (let index = 0; index < 3; index += 1) {
    insertBackfillCandidate(db, {
      requestId: `candidate-${index}`,
      model: "gpt-5-race",
      startedAt: `2026-05-03T00:00:0${index}.000Z`,
    });
  }
  const liveStartedAt = "2026-05-03T00:01:00.000Z";
  const liveId = RequestRepo.insert(db, pendingLog({ request_id: "live-during-backfill", model: "gpt-5-race", started_at: liveStartedAt }));
  let liveFinalizedBeforeBackfillCompleted = false;

  const result = await service.backfillCosts({
    all: true,
    chunkSize: 1,
    async afterChunk(progress) {
      if (progress.scanned !== 1 || liveFinalizedBeforeBackfillCompleted) return;
      liveFinalizedBeforeBackfillCompleted = await service.finalizeUsage(liveId, completedLog({
        request_id: "live-during-backfill",
        model: "gpt-5-race",
        prompt_tokens: 3_000_000,
        total_tokens: 3_000_000,
        started_at: liveStartedAt,
        finished_at: liveStartedAt,
      }));
    },
  });

  expect(liveFinalizedBeforeBackfillCompleted).toBe(true);
  expect(result).toEqual({ scanned: 3, updated: 3, ok: 3, pending: 0, unsupported: 0 });
  expect(toComparableDailyRows(UsageRepo.getDaily(db, "2026-05-03") as AggregateRow[]))
    .toEqual(toComparableDailyRows(aggregateRequestLogs(db)));
  db.close();
});

function insertBackfillCandidate(
  db: Database,
  options: { requestId: string; model: string; startedAt: string },
): number {
  return RequestRepo.insert(db, completedLog({
    request_id: options.requestId,
    model: options.model,
    started_at: options.startedAt,
    finished_at: options.startedAt,
    cost_status: "pending",
  }));
}

function pendingLog(overrides: Partial<Usage.RequestLog> = {}): Omit<Usage.RequestLog, "id"> {
  return {
    ...baseLog(),
    lifecycle_status: "pending",
    cost_status: "unresolved",
    ...overrides,
  };
}

function completedLog(overrides: Partial<Usage.RequestLog> = {}): Omit<Usage.RequestLog, "id"> {
  return {
    ...baseLog(),
    status: 200,
    lifecycle_status: "completed",
    cost_status: "ok",
    finished_at: overrides.started_at ?? "2026-05-03T00:00:00.000Z",
    ...overrides,
  };
}

function baseLog(): Omit<Usage.RequestLog, "id"> {
  return {
    request_id: `req-${crypto.randomUUID()}`,
    provider: "openai",
    model: "gpt-5-race",
    tool: "opencode",
    client_id: "local",
    path: "/v1/chat/completions",
    streamed: 0,
    prompt_tokens: 1_000_000,
    completion_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 1_000_000,
    cost_usd: 0,
    incomplete: 0,
    started_at: "2026-05-03T00:00:00.000Z",
    lifecycle_status: "completed",
    cost_status: "pending",
  };
}

function aggregateRequestLogs(db: Database): AggregateRow[] {
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

function replaceFetch(handler: () => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}
