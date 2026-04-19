import { describe, expect, test } from "bun:test";
import { createRequestContext } from "./requestContext";
import { handleRequest } from "./handleRequest";

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

  test("POST /v1/messages → 501", async () => {
    const req = new Request("http://localhost:3100/v1/messages", { method: "POST" });
    const res = await handleRequest(req);
    expect(res.status).toBe(501);
  });

  test("POST /v1/chat/completions → 501", async () => {
    const req = new Request("http://localhost:3100/v1/chat/completions", { method: "POST" });
    const res = await handleRequest(req);
    expect(res.status).toBe(501);
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
