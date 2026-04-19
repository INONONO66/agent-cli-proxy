import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createRequestContext } from "./requestContext";
import { handleRequest } from "./handleRequest";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis.fetch as unknown) = async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (input instanceof Request) await input.text();
    if (url.includes("/v1/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-opus-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/v1/chat/completions")) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return originalFetch(input);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createRequestContext", () => {
  test("POST /v1/messages → provider anthropic", () => {
    const req = new Request("http://localhost:3100/v1/messages", { method: "POST" });
    const ctx = createRequestContext(req);
    expect(ctx.provider).toBe("anthropic");
    expect(ctx.path).toBe("/v1/messages");
    expect(ctx.method).toBe("POST");
  });

  test("POST /v1/chat/completions → provider openai", () => {
    const req = new Request("http://localhost:3100/v1/chat/completions", { method: "POST" });
    const ctx = createRequestContext(req);
    expect(ctx.provider).toBe("openai");
    expect(ctx.path).toBe("/v1/chat/completions");
    expect(ctx.method).toBe("POST");
  });

  test("GET /health → provider null", () => {
    const req = new Request("http://localhost:3100/health", { method: "GET" });
    const ctx = createRequestContext(req);
    expect(ctx.provider).toBeNull();
    expect(ctx.path).toBe("/health");
    expect(ctx.method).toBe("GET");
  });

  test("id is UUID format", () => {
    const req = new Request("http://localhost:3100/health", { method: "GET" });
    const ctx = createRequestContext(req);
    expect(ctx.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("handleRequest", () => {
  test("GET /health → 200 with status ok", async () => {
    const req = new Request("http://localhost:3100/health", { method: "GET" });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  test("POST /v1/messages → 200 via adapter", async () => {
    const req = new Request("http://localhost:3100/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-5", messages: [] }),
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
  });

  test("POST /v1/chat/completions → 200 via adapter", async () => {
    const req = new Request("http://localhost:3100/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
  });

  test("GET /admin/usage/today → 200", async () => {
    const req = new Request("http://localhost:3100/admin/usage/today", { method: "GET" });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
  });

  test("GET /nonexistent → 404", async () => {
    const req = new Request("http://localhost:3100/nonexistent", { method: "GET" });
    const res = await handleRequest(req);
    expect(res.status).toBe(404);
  });
});
