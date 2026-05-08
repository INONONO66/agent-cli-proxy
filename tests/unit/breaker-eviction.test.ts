import { afterEach, beforeEach, expect, test } from "bun:test";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";

const { UpstreamClient } = await import("../../src/upstream/client");

const originalFetch = globalThis.fetch;

let nowMs = 0;
let fetchCallCount = 0;

function replaceFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  globalThis.fetch = Object.assign(
    ((...args: Parameters<typeof fetch>) => handler(...args)) as typeof fetch,
    { preconnect: originalFetch.preconnect },
  );
}

beforeEach(() => {
  nowMs = 0;
  fetchCallCount = 0;
  UpstreamClient.__resetForTests();
  UpstreamClient.__setTestHooks({
    now: () => nowMs,
    random: () => 0,
    sleep: async () => {},
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  UpstreamClient.__resetForTests();
});

test("evicts inactive closed breakers after BREAKER_EVICT_AFTER_MS", async () => {
  replaceFetch(async () => {
    fetchCallCount += 1;
    return new Response("ok", { status: 200 });
  });

  for (let i = 0; i < 10; i += 1) {
    await UpstreamClient.fetch({
      method: "GET",
      url: "https://upstream.example/test",
      providerId: `provider-${i}`,
    });
  }

  nowMs = 300_001;

  await UpstreamClient.fetch({
    method: "GET",
    url: "https://upstream.example/test",
    providerId: "new-provider",
  });

  expect(UpstreamClient.__getBreakerCountForTests()).toBe(1);
});

test("does not evict open breakers", async () => {
  replaceFetch(async () => {
    fetchCallCount += 1;
    return new Response("fail", { status: 503 });
  });

  for (let i = 0; i < 5; i += 1) {
    await UpstreamClient.fetch({
      method: "GET",
      url: "https://upstream.example/test",
      providerId: "open-provider",
    });
  }

  nowMs = 300_001;

  await UpstreamClient.fetch({
    method: "GET",
    url: "https://upstream.example/test",
    providerId: "new-provider",
  });

  expect(UpstreamClient.__getBreakerCountForTests()).toBe(2);
});

test("does not evict half-open breakers", async () => {
  replaceFetch(async () => {
    fetchCallCount += 1;
    return new Response("fail", { status: 503 });
  });

  for (let i = 0; i < 5; i += 1) {
    await UpstreamClient.fetch({
      method: "GET",
      url: "https://upstream.example/test",
      providerId: "half-open-provider",
    });
  }

  nowMs = 30_001;

  replaceFetch(async () => {
    fetchCallCount += 1;
    return new Response("fail", { status: 503 });
  });

  await UpstreamClient.fetch({
    method: "GET",
    url: "https://upstream.example/test",
    providerId: "half-open-provider",
  });

  nowMs = 300_001;

  await UpstreamClient.fetch({
    method: "GET",
    url: "https://upstream.example/test",
    providerId: "new-provider",
  });

  expect(UpstreamClient.__getBreakerCountForTests()).toBe(2);
});

test("eviction scan runs at most once per 60 seconds", async () => {
  replaceFetch(async () => {
    fetchCallCount += 1;
    return new Response("ok", { status: 200 });
  });

  for (let i = 0; i < 3; i += 1) {
    await UpstreamClient.fetch({
      method: "GET",
      url: "https://upstream.example/test",
      providerId: `provider-${i}`,
    });
  }

  nowMs = 300_001;

  await UpstreamClient.fetch({
    method: "GET",
    url: "https://upstream.example/test",
    providerId: "trigger-1",
  });

  expect(UpstreamClient.__getBreakerCountForTests()).toBe(1);

  await UpstreamClient.fetch({
    method: "GET",
    url: "https://upstream.example/test",
    providerId: "trigger-2",
  });

  expect(UpstreamClient.__getBreakerCountForTests()).toBe(2);
});
