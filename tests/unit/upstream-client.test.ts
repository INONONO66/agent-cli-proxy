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

  // short-circuit uses upstream.breaker_reject, not upstream.error
  expect(logs.some((entry) => entry.fields?.event === "upstream.breaker_reject")).toBe(true);
  // short-circuit should NOT produce upstream.error
  const shortCircuitErrors = logs.filter(
    (entry) => entry.fields?.event === "upstream.error" && entry.fields?.code === "short-circuit",
  );
  expect(shortCircuitErrors).toHaveLength(0);
});

test("short-circuit response includes Retry-After header", async () => {
  replaceFetch(async () => new Response("failed", { status: 503 }));

  for (let i = 0; i < 5; i += 1) {
    await UpstreamClient.fetch({
      method: "POST",
      url: "https://upstream.example/breaker",
      providerId: "retry-after-provider",
      idempotent: false,
    });
  }

  const short = await UpstreamClient.fetch({
    method: "POST",
    url: "https://upstream.example/breaker",
    providerId: "retry-after-provider",
    idempotent: false,
  });

  expect(short.headers.get("retry-after")).toBe("30");
});

test("configurable breaker threshold via __setTestHooks", async () => {
  UpstreamClient.__setTestHooks({ openAfterFailures: 3 });

  let attempts = 0;
  replaceFetch(async () => {
    attempts += 1;
    return new Response("failed", { status: 503 });
  });

  for (let i = 0; i < 3; i += 1) {
    await UpstreamClient.fetch({
      method: "POST",
      url: "https://upstream.example/threshold",
      providerId: "threshold-provider",
      idempotent: false,
    });
  }

  const short = await UpstreamClient.fetch({
    method: "POST",
    url: "https://upstream.example/threshold",
    providerId: "threshold-provider",
    idempotent: false,
  });
  const body = await short.json() as { error: { code: string } };

  expect(attempts).toBe(3);
  expect(body.error.code).toBe("short-circuit");
});

test("getBreakerSnapshots returns current breaker state", async () => {
  replaceFetch(async () => new Response("failed", { status: 503 }));

  for (let i = 0; i < 5; i += 1) {
    await UpstreamClient.fetch({
      method: "POST",
      url: "https://upstream.example/snap",
      providerId: "snap-provider",
      idempotent: false,
    });
  }

  const snapshots = UpstreamClient.getBreakerSnapshots();
  const snap = snapshots.find((s) => s.providerId === "snap-provider");
  expect(snap).toBeDefined();
  expect(snap!.state).toBe("open");
  expect(snap!.failures).toBe(5);
});

test("resetBreaker closes an open breaker", async () => {
  replaceFetch(async () => new Response("failed", { status: 503 }));

  for (let i = 0; i < 5; i += 1) {
    await UpstreamClient.fetch({
      method: "POST",
      url: "https://upstream.example/reset",
      providerId: "reset-provider",
      idempotent: false,
    });
  }

  expect(UpstreamClient.resetBreaker("reset-provider")).toBe(true);

  const snap = UpstreamClient.getBreakerSnapshots().find((s) => s.providerId === "reset-provider");
  expect(snap!.state).toBe("closed");
  expect(snap!.failures).toBe(0);

  // after reset, requests go through to upstream again
  let fetched = false;
  replaceFetch(async () => {
    fetched = true;
    return new Response("ok", { status: 200 });
  });

  await UpstreamClient.fetch({
    method: "POST",
    url: "https://upstream.example/reset",
    providerId: "reset-provider",
    idempotent: false,
  });
  expect(fetched).toBe(true);
});

test("resetBreaker returns false for unknown provider", () => {
  expect(UpstreamClient.resetBreaker("nonexistent")).toBe(false);
});

test("upstream 503 with short-circuit body does not count as breaker failure", async () => {
  const shortCircuitBody = JSON.stringify({
    error: { code: "short-circuit", status: 503, providerId: "openai", retryable: false, cause: "circuit breaker open" },
  });

  replaceFetch(async () => new Response(shortCircuitBody, {
    status: 503,
    headers: { "content-type": "application/json" },
  }));

  for (let i = 0; i < 10; i += 1) {
    await UpstreamClient.fetch({
      method: "POST",
      url: "https://upstream.example/passthrough",
      providerId: "passthrough-provider",
      idempotent: false,
    });
  }

  const snap = UpstreamClient.getBreakerSnapshots().find((s) => s.providerId === "passthrough-provider");
  expect(snap!.state).toBe("closed");
  expect(snap!.failures).toBe(0);
  expect(logs.some((entry) => entry.fields?.event === "upstream.passthrough_short_circuit")).toBe(true);
});

test("upstream 503 without short-circuit body still counts as breaker failure", async () => {
  replaceFetch(async () => new Response("generic server error", { status: 503 }));

  for (let i = 0; i < 5; i += 1) {
    await UpstreamClient.fetch({
      method: "POST",
      url: "https://upstream.example/generic",
      providerId: "generic-provider",
      idempotent: false,
    });
  }

  const snap = UpstreamClient.getBreakerSnapshots().find((s) => s.providerId === "generic-provider");
  expect(snap!.state).toBe("open");
  expect(snap!.failures).toBe(5);
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
