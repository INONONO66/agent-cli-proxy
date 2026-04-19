import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { RequestContext } from "./requestContext";
import type { TokenUsage } from "../types/index";

const mockRecordUsage = mock((_log: unknown) => 1);

const today = new Date().toISOString().slice(0, 10);

mock.module("../services/index", () => ({
  usageService: {
    recordUsage: mockRecordUsage,
    getToday: () => ({ date: today, requests: 0, total_tokens: 0, cost_usd: 0, breakdown: [] }),
    getDateRange: () => [],
    getModelBreakdown: () => [],
    getProviderBreakdown: () => [],
    getTotalStats: () => ({
      total_requests: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      first_request_at: null,
      last_request_at: null,
    }),
    getRecentLogs: () => [],
    getLogById: () => null,
  },
}));

const { withUsageLogging } = await import("./logUsage");

function makeCtx(overrides?: Partial<RequestContext>): RequestContext {
  return {
    id: "test-id",
    startedAt: Date.now(),
    provider: "anthropic",
    path: "/v1/messages",
    method: "POST",
    ...overrides,
  };
}

function makeRequest(body: object = { model: "claude-opus-4-5" }): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockRecordUsage.mockClear();
});

describe("withUsageLogging", () => {
  test("onUsage callback is called when handler completes", async () => {
    const usage: TokenUsage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 150,
      incomplete: false,
    };

    const handler = mock(
      async (
        _req: Request,
        _ctx: RequestContext,
        onUsage?: (u: TokenUsage) => void
      ) => {
        onUsage?.(usage);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    );

    const wrapped = withUsageLogging(handler);
    const resp = await wrapped(makeRequest(), makeCtx());

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        incomplete: 0,
      })
    );
  });

  test("error in handler records usage with error_code", async () => {
    const handler = mock(
      async (_req: Request, _ctx: RequestContext): Promise<Response> => {
        throw new Error("upstream failure");
      }
    );

    const wrapped = withUsageLogging(handler);
    await expect(wrapped(makeRequest(), makeCtx())).rejects.toThrow(
      "upstream failure"
    );

    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        error_code: "internal_error",
        incomplete: 1,
        status: 500,
      })
    );
  });

  test("model is extracted from request body", async () => {
    const usage: TokenUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
      incomplete: false,
    };

    const handler = mock(
      async (
        _req: Request,
        _ctx: RequestContext,
        onUsage?: (u: TokenUsage) => void
      ) => {
        onUsage?.(usage);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    );

    const wrapped = withUsageLogging(handler);
    await wrapped(makeRequest({ model: "claude-3-5-sonnet" }), makeCtx());

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-3-5-sonnet" })
    );
  });
});
