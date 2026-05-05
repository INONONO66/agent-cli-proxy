import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

process.env.PROXY_LOCAL_OK = "1";
process.env.PRICING_CACHE_PATH = join(tmpdir(), `agent-cli-proxy-cost-${crypto.randomUUID()}.json`);

const { Cost } = await import("../../src/storage/cost");
const { Pricing } = await import("../../src/storage/pricing");
const { Storage } = await import("../../src/storage/db");
const { RequestRepo } = await import("../../src/storage/repo");
const { UsageService } = await import("../../src/storage/service");
const { Logger } = await import("../../src/util/logger");

const originalFetch = globalThis.fetch;
const unitPrice = { input: 1, output: 2, cache_read: 0.5, cache_write: 3, reasoning: 4 };

beforeEach(() => {
  Pricing.__setPricingForTests([
    ["openai/gpt-5.4-mini", unitPrice],
    ["gpt-5.4-mini", unitPrice],
  ]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Cost.__resetLoggerForTests();
  Pricing.__clearPricingForTests();
  rmSync(process.env.PRICING_CACHE_PATH ?? "", { force: true });
});

test("Cost.compute returns ok with positive pricing cost", () => {
  const result = Cost.compute({
    provider: "openai",
    model: "gpt-5.4-mini",
    usage: {
      prompt_tokens: 1_000_000,
      completion_tokens: 500_000,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      reasoning_tokens: 0,
    },
  });

  expect(result.cost_status).toBe("ok");
  expect(result.source).toBe("pricing");
  expect(result.cost_usd).toBe(2);
  expect(result.cost_usd).toBeGreaterThan(0);
});

test("Cost.compute marks sentinel unknown models unsupported", () => {
  expect(Cost.compute({ provider: "openai", model: "unknown", usage: {} })).toEqual({
    cost_usd: 0,
    cost_status: "unsupported",
    source: "unsupported_model",
  });
  expect(Cost.compute({ provider: "openai", model: "", usage: {} }).cost_status).toBe("unsupported");
});

test("Cost.compute returns pending for known but unpriced model", () => {
  const result = Cost.compute({ provider: "openai", model: "gpt-5-unpriced", usage: { prompt_tokens: 1 } });

  expect(result).toEqual({ cost_usd: 0, cost_status: "pending", source: "pricing" });
});

test("Cost.compute guards NaN, negative, and Infinity costs with cost.guard logs", () => {
  const records: string[] = [];
  Cost.__setLoggerForTests(Logger.create({
    level: "warn",
    format: "json",
    sink: {
      stdout(line) {
        records.push(line);
      },
      stderr(line) {
        records.push(line);
      },
    },
  }).child({ component: "cost" }));

  for (const [model, input] of [
    ["nan-model", Number.NaN],
    ["negative-model", -1],
    ["infinite-model", Number.POSITIVE_INFINITY],
  ] as Array<[string, number]>) {
    Pricing.__setPricingForTests([[`openai/${model}`, { input, output: 1 }]]);
    const result = Cost.compute({ provider: "openai", model, usage: { prompt_tokens: 1 } });
    expect(result).toEqual({ cost_usd: 0, cost_status: "pending", source: "guard" });
  }

  expect(records).toHaveLength(3);
  for (const line of records) {
    expect(line).toContain('"event":"cost.guard"');
    expect(line).toContain('"level":"warn"');
  }
});

test("Cost.compute keeps zero usage pending to preserve ok implies positive cost", () => {
  const result = Cost.compute({
    provider: "openai",
    model: "gpt-5.4-mini",
    usage: { prompt_tokens: 0, completion_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0 },
  });

  expect(result).toEqual({ cost_usd: 0, cost_status: "pending", source: "guard" });
  if (result.cost_status === "ok") expect(result.cost_usd).toBeGreaterThan(0);
});

test("pricing fallback after first fetch failure is immediately stale and retries upstream", async () => {
  Pricing.__clearPricingForTests();
  let attempts = 0;
  globalThis.fetch = (() => {
    attempts += 1;
    return Promise.reject(new Error("network down"));
  }) as typeof fetch;

  await Pricing.fetchPricing();
  await Pricing.fetchPricing();

  expect(attempts).toBe(2);
});

test("pricing lookup does not match unsafe key-substring aliases", () => {
  Pricing.__setPricingForTests([["gpt-5.4", unitPrice]]);

  expect(Pricing.getPricing("gpt-5-some-variant-2026", "openai")).toBeNull();
});

test("backfill transitions pending priced rows to ok and writes audit", async () => {
  globalThis.fetch = (() => Promise.reject(new Error("use in-memory pricing"))) as typeof fetch;
  Pricing.__setPricingForTests([["openai/gpt-5.4-mini", unitPrice]]);
  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);
  const id = RequestRepo.insert(db, {
    request_id: "pending-cost",
    provider: "openai",
    model: "gpt-5.4-mini",
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
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });

  const result = await service.backfillCosts({ all: true });
  const row = RequestRepo.getById(db, id);
  const audits = db.query("SELECT * FROM cost_audit WHERE request_log_id = ?").all(id);

  expect(result).toEqual({ scanned: 1, updated: 1, ok: 1, pending: 0, unsupported: 0 });
  expect(row?.cost_status).toBe("ok");
  expect(row?.cost_usd).toBeGreaterThan(0);
  expect(audits).toHaveLength(1);
  db.close();
});
