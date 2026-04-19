import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "./sqlite";
import {
  insertRequest,
  updateRequest,
  getRequestsByDate,
  getRequestById,
} from "./requestsRepo";
import { upsertDailyUsage, getDailyUsage, getUsageRange } from "./usageRepo";
import type { RequestLog, DailyUsage } from "../types";

let db: Database;

beforeEach(() => {
  db = initDb(":memory:");
});

describe("requestsRepo", () => {
  it("insertRequest returns valid id", () => {
    const log: Omit<RequestLog, "id"> = {
      provider: "anthropic",
      model: "claude-3-sonnet",
      path: "/v1/messages",
      streamed: 0,
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 150,
      cost_usd: 0.001,
      incomplete: 0,
      started_at: "2025-04-20T10:00:00Z",
    };

    const id = insertRequest(db, log);
    expect(id).toBeGreaterThan(0);
  });

  it("updateRequest reflects changes", () => {
    const log: Omit<RequestLog, "id"> = {
      provider: "anthropic",
      model: "claude-3-sonnet",
      path: "/v1/messages",
      streamed: 0,
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 150,
      cost_usd: 0.001,
      incomplete: 0,
      started_at: "2025-04-20T10:00:00Z",
    };

    const id = insertRequest(db, log);
    updateRequest(db, id, {
      status: 200,
      finished_at: "2025-04-20T10:00:05Z",
      latency_ms: 5000,
    });

    const updated = getRequestById(db, id);
    expect(updated?.status).toBe(200);
    expect(updated?.finished_at).toBe("2025-04-20T10:00:05Z");
    expect(updated?.latency_ms).toBe(5000);
  });

  it("getRequestsByDate returns correct records", () => {
    const log1: Omit<RequestLog, "id"> = {
      provider: "anthropic",
      model: "claude-3-sonnet",
      path: "/v1/messages",
      streamed: 0,
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
      cost_usd: 0.003,
      incomplete: 0,
      started_at: "2025-04-21T10:00:00Z",
    };

    insertRequest(db, log1);
    insertRequest(db, log2);

    const results = getRequestsByDate(db, "2025-04-20");
    expect(results).toHaveLength(1);
    expect(results[0].provider).toBe("anthropic");
  });
});

describe("usageRepo", () => {
  it("upsertDailyUsage accumulates values", () => {
    const usage1: DailyUsage = {
      day: "2025-04-20",
      provider: "anthropic",
      model: "claude-3-sonnet",
      request_count: 5,
      prompt_tokens: 500,
      completion_tokens: 250,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 750,
      cost_usd: 0.005,
    };

    const usage2: DailyUsage = {
      day: "2025-04-20",
      provider: "anthropic",
      model: "claude-3-sonnet",
      request_count: 3,
      prompt_tokens: 300,
      completion_tokens: 150,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 450,
      cost_usd: 0.003,
    };

    upsertDailyUsage(db, usage1);
    upsertDailyUsage(db, usage2);

    const results = getDailyUsage(db, "2025-04-20");
    expect(results).toHaveLength(1);
    expect(results[0].request_count).toBe(8);
    expect(results[0].prompt_tokens).toBe(800);
    expect(results[0].completion_tokens).toBe(400);
    expect(results[0].total_tokens).toBe(1200);
    expect(results[0].cost_usd).toBe(0.008);
  });

  it("getDailyUsage returns correct day", () => {
    const usage1: DailyUsage = {
      day: "2025-04-20",
      provider: "anthropic",
      model: "claude-3-sonnet",
      request_count: 5,
      prompt_tokens: 500,
      completion_tokens: 250,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 750,
      cost_usd: 0.005,
    };

    const usage2: DailyUsage = {
      day: "2025-04-21",
      provider: "anthropic",
      model: "claude-3-sonnet",
      request_count: 3,
      prompt_tokens: 300,
      completion_tokens: 150,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 450,
      cost_usd: 0.003,
    };

    upsertDailyUsage(db, usage1);
    upsertDailyUsage(db, usage2);

    const results = getDailyUsage(db, "2025-04-20");
    expect(results).toHaveLength(1);
    expect(results[0].day).toBe("2025-04-20");
  });

  it("getUsageRange returns range", () => {
    const usage1: DailyUsage = {
      day: "2025-04-20",
      provider: "anthropic",
      model: "claude-3-sonnet",
      request_count: 5,
      prompt_tokens: 500,
      completion_tokens: 250,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 750,
      cost_usd: 0.005,
    };

    const usage2: DailyUsage = {
      day: "2025-04-21",
      provider: "anthropic",
      model: "claude-3-sonnet",
      request_count: 3,
      prompt_tokens: 300,
      completion_tokens: 150,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 450,
      cost_usd: 0.003,
    };

    const usage3: DailyUsage = {
      day: "2025-04-22",
      provider: "openai",
      model: "gpt-4",
      request_count: 2,
      prompt_tokens: 200,
      completion_tokens: 100,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 300,
      cost_usd: 0.002,
    };

    upsertDailyUsage(db, usage1);
    upsertDailyUsage(db, usage2);
    upsertDailyUsage(db, usage3);

    const results = getUsageRange(db, "2025-04-20", "2025-04-21");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.day >= "2025-04-20" && r.day <= "2025-04-21")).toBe(true);
  });
});
