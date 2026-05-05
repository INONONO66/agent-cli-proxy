import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { RequestInfo } from "../../src/server/request-inspector";
import type { Usage } from "../../src/usage";

const timeoutMs = 30;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let nonStreamingCanceled = 0;
let streamingBeforeChunkCanceled = 0;
let streamingAfterChunkCanceled = 0;

function stalledBody(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    cancel() {
      onCancel();
    },
  });
}

function oneChunkThenStall(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } })}\n`));
    },
    cancel() {
      onCancel();
    },
  });
}

const originalFetch = globalThis.fetch;
const originalEnv = {
  CLI_PROXY_API_URL: process.env.CLI_PROXY_API_URL,
  UPSTREAM_TIMEOUT_MS: process.env.UPSTREAM_TIMEOUT_MS,
  UPSTREAM_CONNECT_TIMEOUT_MS: process.env.UPSTREAM_CONNECT_TIMEOUT_MS,
  LOG_LEVEL: process.env.LOG_LEVEL,
};

process.env.CLI_PROXY_API_URL = "http://upstream.test";
process.env.UPSTREAM_TIMEOUT_MS = String(timeoutMs);
process.env.UPSTREAM_CONNECT_TIMEOUT_MS = String(timeoutMs);
process.env.LOG_LEVEL = "error";

const { RequestInspector } = await import("../../src/server/request-inspector");
const { PassThroughProxy } = await import("../../src/server/pass-through");
const { UpstreamClient } = await import("../../src/upstream/client");
const { Storage } = await import("../../src/storage/db");
const { UsageService } = await import("../../src/storage/service");
const { Pricing } = await import("../../src/storage/pricing");

const price = { input: 1, output: 1, cache_read: 1, cache_write: 1, reasoning: 1 };

beforeEach(() => {
  nonStreamingCanceled = 0;
  streamingBeforeChunkCanceled = 0;
  streamingAfterChunkCanceled = 0;
  Pricing.__setPricingForTests([
    ["openai/gpt-4o", price],
    ["gpt-4o", price],
  ]);
  UpstreamClient.__setTestHooks({
    upstreamTimeoutMs: timeoutMs,
    upstreamConnectTimeoutMs: timeoutMs,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  UpstreamClient.__resetForTests();
});

afterAll(() => {
  restoreEnv("CLI_PROXY_API_URL", originalEnv.CLI_PROXY_API_URL);
  restoreEnv("UPSTREAM_TIMEOUT_MS", originalEnv.UPSTREAM_TIMEOUT_MS);
  restoreEnv("UPSTREAM_CONNECT_TIMEOUT_MS", originalEnv.UPSTREAM_CONNECT_TIMEOUT_MS);
  restoreEnv("LOG_LEVEL", originalEnv.LOG_LEVEL);
});

function createHarness() {
  const db = Storage.initDb(":memory:");
  const usageService = UsageService.create(db);
  const handle = PassThroughProxy.create(usageService);
  return { db, handle };
}

function request(path: string, stream = false): Request {
  return new Request(`http://proxy.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "opencode/1.0" },
    body: JSON.stringify({ model: "gpt-4o", stream, messages: [{ role: "user", content: "hi" }] }),
  });
}

async function inspect(req: Request): Promise<RequestInfo> {
  return RequestInspector.inspect(req);
}

function latest(db: Database): Usage.RequestLog {
  return db.query("SELECT * FROM request_logs ORDER BY id DESC LIMIT 1").get() as Usage.RequestLog;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replaceFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => handler(...args)) as typeof fetch;
}

function restoreEnv(key: keyof typeof originalEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

test("non-streaming upstream body timeout finalizes with marker", async () => {
  replaceFetch(async () => new Response(stalledBody(() => {
    nonStreamingCanceled += 1;
  }), { status: 200, headers: { "content-type": "application/json" } }));

  const { db, handle } = createHarness();
  const req = request("/non-streaming-stall");

  const res = await handle(req, await inspect(req));
  await res.text();

  expect(res.status).toBe(504);
  expect(nonStreamingCanceled).toBeGreaterThan(0);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "error",
    error_code: "upstream_timeout",
    incomplete: 1,
  });
  expect(latest(db).error_message ?? "").toContain("upstream_body_timeout");
});

test("streaming upstream body timeout before first chunk returns proxy error", async () => {
  replaceFetch(async () => new Response(stalledBody(() => {
    streamingBeforeChunkCanceled += 1;
  }), { status: 200, headers: { "content-type": "text/event-stream" } }));

  const { db, handle } = createHarness();
  const req = request("/streaming-stall-before-chunk", true);

  const res = await handle(req, await inspect(req));
  await res.text();

  expect(res.status).toBe(504);
  expect(streamingBeforeChunkCanceled).toBeGreaterThan(0);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "error",
    error_code: "upstream_timeout",
    incomplete: 1,
  });
  expect(latest(db).error_message ?? "").toContain("upstream_body_timeout");
});

test("streaming timeout is released after forwarding the first chunk", async () => {
  replaceFetch(async () => new Response(oneChunkThenStall(() => {
    streamingAfterChunkCanceled += 1;
  }), { status: 200, headers: { "content-type": "text/event-stream" } }));

  const { db, handle } = createHarness();
  const req = request("/streaming-stall-after-chunk", true);

  const res = await handle(req, await inspect(req));
  const reader = res.body?.getReader();
  expect(reader).toBeDefined();
  const first = await reader?.read();

  expect(res.status).toBe(200);
  expect(first?.done).toBe(false);
  expect(decoder.decode(first?.value)).toContain("data:");

  await delay(timeoutMs * 3);
  expect(latest(db).lifecycle_status).toBe("pending");
  expect(streamingAfterChunkCanceled).toBe(0);

  await reader?.cancel("client finished assertion");
  await delay(5);

  expect(streamingAfterChunkCanceled).toBe(1);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "aborted",
    error_code: "aborted",
    incomplete: 1,
  });
  expect(latest(db).error_message ?? "").not.toContain("upstream_body_timeout");
});
