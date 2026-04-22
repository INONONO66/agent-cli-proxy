import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startMockCliProxyApi } from "./mockCliProxyApi";

const PROXY_PORT = 13100;
const MOCK_MODE = process.env.MOCK_CLI_PROXY === "1";

const CLI_PROXY_URL = process.env.CLI_PROXY_API_URL ?? "http://localhost:18317";
const MOCK_PORT = Number(new URL(CLI_PROXY_URL).port || "18317");

describe.if(MOCK_MODE)("E2E Proxy Tests (mock mode)", () => {
  let mockServer: ReturnType<typeof startMockCliProxyApi>;
  let proxyServer: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    process.env.DB_PATH = ":memory:";

    mockServer = startMockCliProxyApi(MOCK_PORT);

    const { Handler } = await import("../../src/server/handler");
    const { Storage } = await import("../../src/storage/db");
    const { UsageService } = await import("../../src/storage/service");
    const { Config } = await import("../../src/config");
    
    const db = Storage.initDb(":memory:");
    const usageService = UsageService.create(db);
    const handleRequest = Handler.create(usageService);

    proxyServer = Bun.serve({
      port: PROXY_PORT,
      idleTimeout: 0,
      fetch: handleRequest,
    });

    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    mockServer.stop();
    proxyServer.stop(true);
    await new Promise((r) => setTimeout(r, 50));
  });

  const BASE = `http://localhost:${PROXY_PORT}`;

  it("GET /health → 200", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
  });

  it("Anthropic non-streaming → 200 with content", async () => {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 20,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.content).toBeDefined();
  });

  it("Anthropic streaming → SSE events", async () => {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 20,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("message_start");
  });

  it("OpenAI non-streaming → 200 with choices", async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 20,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.choices).toBeDefined();
  });

  it("OpenAI streaming → SSE events with [DONE]", async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 20,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("data: [DONE]");
  });

  it("Admin /usage/today → 200 with date", async () => {
    const res = await fetch(`${BASE}/admin/usage/today`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.date).toBeDefined();
  });

  it("Admin /stats → 200 with total_requests", async () => {
    const res = await fetch(`${BASE}/admin/stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.total_requests).toBe("number");
  });

  it("Admin /logs → 200 array", async () => {
    const res = await fetch(`${BASE}/admin/logs?limit=10&offset=0`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("Unknown route → 404", async () => {
    const res = await fetch(`${BASE}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("Anthropic request has Claude Code headers forwarded to mock", async () => {
    const prevLen = mockServer.receivedRequests.length;
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 10,
        messages: [{ role: "user", content: "test" }],
      }),
    });
    await res.text();
    expect(mockServer.receivedRequests.length).toBeGreaterThan(prevLen);
    const lastReq = mockServer.receivedRequests[mockServer.receivedRequests.length - 1];
    expect(lastReq?.headers["user-agent"]).toContain("claude-cli");
  });
});
