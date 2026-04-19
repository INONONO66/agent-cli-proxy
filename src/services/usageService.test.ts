import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../db/sqlite";
import { createUsageService } from "./usageService";
import type { RequestLog } from "../types";

let db: Database;

beforeEach(() => {
  db = initDb(":memory:");
});

describe("usageService", () => {
  it("recordUsage inserts into request_logs and daily_usage", async () => {
    const service = createUsageService(db);

    const log: Omit<RequestLog, "id"> = {
      provider: "openai",
      model: "gpt-4",
      path: "/v1/chat/completions",
      streamed: 1,
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 150,
      cost_usd: 0.001,
      incomplete: 0,
      started_at: "2025-04-20T10:00:00Z",
    };

    const id = await service.recordUsage(log);
    expect(id).toBeGreaterThan(0);

    const stats = service.getTotalStats();
    expect(stats.total_requests).toBe(1);
    expect(stats.total_tokens).toBe(150);
  });

  it("two recordUsage calls show request_count=2 in getToday", async () => {
    const service = createUsageService(db);
    const today = new Date().toISOString().slice(0, 10);

    const log1: Omit<RequestLog, "id"> = {
      provider: "openai",
      model: "gpt-4",
      path: "/v1/chat/completions",
      streamed: 1,
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 150,
      cost_usd: 0.001,
      incomplete: 0,
      started_at: `${today}T10:00:00Z`,
    };

    const log2: Omit<RequestLog, "id"> = {
      provider: "openai",
      model: "gpt-4",
      path: "/v1/chat/completions",
      streamed: 1,
      prompt_tokens: 200,
      completion_tokens: 100,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 300,
      cost_usd: 0.002,
      incomplete: 0,
      started_at: `${today}T11:00:00Z`,
    };

    await service.recordUsage(log1);
    await service.recordUsage(log2);

    const todaySummary = service.getToday();
    expect(todaySummary.requests).toBe(2);
    expect(todaySummary.total_tokens).toBe(450);
    expect(todaySummary.cost_usd).toBeCloseTo(0.003, 5);
  });

  it("getModelBreakdown returns per-model rows", async () => {
    const service = createUsageService(db);
    const day = "2025-04-20";

    const log1: Omit<RequestLog, "id"> = {
      provider: "openai",
      model: "gpt-4",
      path: "/v1/chat/completions",
      streamed: 1,
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 150,
      cost_usd: 0.001,
      incomplete: 0,
      started_at: `${day}T10:00:00Z`,
    };

    const log2: Omit<RequestLog, "id"> = {
      provider: "openai",
      model: "gpt-3.5-turbo",
      path: "/v1/chat/completions",
      streamed: 1,
      prompt_tokens: 200,
      completion_tokens: 100,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 300,
      cost_usd: 0.0005,
      incomplete: 0,
      started_at: `${day}T11:00:00Z`,
    };

    await service.recordUsage(log1);
    await service.recordUsage(log2);

    const breakdown = service.getModelBreakdown(day);
    expect(breakdown).toHaveLength(2);
    expect(breakdown.some((r) => r.model === "gpt-4")).toBe(true);
    expect(breakdown.some((r) => r.model === "gpt-3.5-turbo")).toBe(true);
  });

  it("getProviderBreakdown aggregates by provider", async () => {
    const service = createUsageService(db);
    const day = "2025-04-20";

    const log1: Omit<RequestLog, "id"> = {
      provider: "openai",
      model: "gpt-4",
      path: "/v1/chat/completions",
      streamed: 1,
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 150,
      cost_usd: 0.001,
      incomplete: 0,
      started_at: `${day}T10:00:00Z`,
    };

    const log2: Omit<RequestLog, "id"> = {
      provider: "anthropic",
      model: "claude-3-sonnet",
      path: "/v1/messages",
      streamed: 1,
      prompt_tokens: 200,
      completion_tokens: 100,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 300,
      cost_usd: 0.002,
      incomplete: 0,
      started_at: `${day}T11:00:00Z`,
    };

    await service.recordUsage(log1);
    await service.recordUsage(log2);

    const breakdown = service.getProviderBreakdown(day);
    expect(breakdown).toHaveLength(2);

    const openaiRow = breakdown.find((r) => r.provider === "openai");
    expect(openaiRow?.request_count).toBe(1);
    expect(openaiRow?.total_tokens).toBe(150);

    const anthropicRow = breakdown.find((r) => r.provider === "anthropic");
    expect(anthropicRow?.request_count).toBe(1);
    expect(anthropicRow?.total_tokens).toBe(300);
  });

  it("getTotalStats returns correct totals", async () => {
    const service = createUsageService(db);

    const log1: Omit<RequestLog, "id"> = {
      provider: "openai",
      model: "gpt-4",
      path: "/v1/chat/completions",
      streamed: 1,
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 150,
      cost_usd: 0.001,
      incomplete: 0,
      started_at: "2025-04-20T10:00:00Z",
    };

    const log2: Omit<RequestLog, "id"> = {
      provider: "openai",
      model: "gpt-4",
      path: "/v1/chat/completions",
      streamed: 1,
      prompt_tokens: 200,
      completion_tokens: 100,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 300,
      cost_usd: 0.002,
      incomplete: 0,
      started_at: "2025-04-21T10:00:00Z",
    };

    await service.recordUsage(log1);
    await service.recordUsage(log2);

    const stats = service.getTotalStats();
    expect(stats.total_requests).toBe(2);
    expect(stats.total_tokens).toBe(450);
    expect(stats.total_cost_usd).toBeCloseTo(0.003, 5);
    expect(stats.first_request_at).toBe("2025-04-20T10:00:00Z");
    expect(stats.last_request_at).toBe("2025-04-21T10:00:00Z");
  });

  it("getDateRange returns summaries for date range", async () => {
    const service = createUsageService(db);

    const log1: Omit<RequestLog, "id"> = {
      provider: "openai",
      model: "gpt-4",
      path: "/v1/chat/completions",
      streamed: 1,
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 150,
      cost_usd: 0.001,
      incomplete: 0,
      started_at: "2025-04-20T10:00:00Z",
    };

    const log2: Omit<RequestLog, "id"> = {
      provider: "openai",
      model: "gpt-4",
      path: "/v1/chat/completions",
      streamed: 1,
      prompt_tokens: 200,
      completion_tokens: 100,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 300,
      cost_usd: 0.002,
      incomplete: 0,
      started_at: "2025-04-21T10:00:00Z",
    };

    await service.recordUsage(log1);
    await service.recordUsage(log2);

    const range = service.getDateRange("2025-04-20", "2025-04-21");
    expect(range).toHaveLength(2);
    expect(range[0].date).toBe("2025-04-21");
    expect(range[1].date).toBe("2025-04-20");
  });
});
