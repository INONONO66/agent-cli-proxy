import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Logger } from "../../src/util/logger";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";

const { UpstreamClient } = await import("../../src/upstream/client");

const originalFetch = globalThis.fetch;

let nowMs = 0;
let logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];

function captureLogger(): Logger.Logger {
  const logger: Logger.Logger = {
    child() {
      return logger;
    },
    debug(msg, fields) {
      logs.push({ level: "debug", msg, fields });
    },
    info(msg, fields) {
      logs.push({ level: "info", msg, fields });
    },
    warn(msg, fields) {
      logs.push({ level: "warn", msg, fields });
    },
    error(msg, fields) {
      logs.push({ level: "error", msg, fields });
    },
  };
  return logger;
}

function replaceFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  globalThis.fetch = Object.assign(
    ((...args: Parameters<typeof fetch>) => handler(...args)) as typeof fetch,
    { preconnect: originalFetch.preconnect },
  );
}

beforeEach(() => {
  nowMs = 0;
  logs = [];
  UpstreamClient.__resetForTests();
  UpstreamClient.__setTestHooks({
    now: () => nowMs,
    random: () => 0,
    sleep: async () => {},
    logger: captureLogger(),
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  UpstreamClient.__resetForTests();
});

test("retries idempotent 5xx responses up to success", async () => {
  let attempts = 0;
  replaceFetch(async () => {
    attempts += 1;
    return new Response(attempts < 3 ? "temporary" : "ok", { status: attempts < 3 ? 503 : 200 });
  });

  const res = await UpstreamClient.fetch({
    method: "GET",
    url: "https://upstream.example/retry",
    providerId: "retry-provider",
    idempotent: true,
  });

  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
  expect(attempts).toBe(3);
  expect(logs.filter((entry) => entry.fields?.event === "upstream.error")).toHaveLength(2);
});

test("does not retry streaming requests even when marked idempotent", async () => {
  let attempts = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  replaceFetch(async () => {
    attempts += 1;
    return new Response("stream failed", { status: 503 });
  });

  const res = await UpstreamClient.fetch({
    method: "POST",
    url: "https://upstream.example/stream",
    headers: { accept: "text/event-stream" },
    body,
    providerId: "stream-provider",
    idempotent: true,
  });

  expect(res.status).toBe(503);
  expect(await res.text()).toBe("stream failed");
  expect(attempts).toBe(1);
  expect(logs.at(-1)?.fields).toMatchObject({ event: "upstream.error", retryable: false, retrying: false });
});

test("opens breaker after five failures and short-circuits without fetch", async () => {
  let attempts = 0;
  replaceFetch(async () => {
    attempts += 1;
    return new Response("failed", { status: 503 });
  });

  for (let i = 0; i < 5; i += 1) {
    const res = await UpstreamClient.fetch({
      method: "POST",
      url: "https://upstream.example/breaker",
      providerId: "breaker-provider",
      idempotent: false,
    });
    expect(res.status).toBe(503);
  }

  const short = await UpstreamClient.fetch({
    method: "POST",
    url: "https://upstream.example/breaker",
    providerId: "breaker-provider",
    idempotent: false,
  });
  const body = await short.json() as { error: { code: string; providerId: string } };

  expect(attempts).toBe(5);
  expect(short.status).toBe(503);
  expect(body.error).toMatchObject({ code: "short-circuit", providerId: "breaker-provider" });
  expect(logs.some((entry) => entry.fields?.event === "upstream.short_circuit")).toBe(true);
});

test("half-open success closes breaker and allows later calls", async () => {
  let attempts = 0;
  replaceFetch(async () => {
    attempts += 1;
    return new Response(attempts <= 5 ? "failed" : "recovered", { status: attempts <= 5 ? 503 : 200 });
  });

  for (let i = 0; i < 5; i += 1) {
    await UpstreamClient.fetch({
      method: "POST",
      url: "https://upstream.example/half-open",
      providerId: "half-open-provider",
      idempotent: false,
    });
  }

  nowMs = 30_001;
  const recovered = await UpstreamClient.fetch({
    method: "POST",
    url: "https://upstream.example/half-open",
    providerId: "half-open-provider",
    idempotent: false,
  });
  const later = await UpstreamClient.fetch({
    method: "POST",
    url: "https://upstream.example/half-open",
    providerId: "half-open-provider",
    idempotent: false,
  });

  expect(await recovered.text()).toBe("recovered");
  expect(await later.text()).toBe("recovered");
  expect(attempts).toBe(7);
});
