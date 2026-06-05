import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { CLIProxyClient as CLIProxyClientNS } from "../../src/cliproxy/client";

process.env.PROXY_LOCAL_OK = "1";
process.env.CLIPROXY_MGMT_KEY = "test-mgmt-key";

const { CLIProxyClient } = await import("../../src/cliproxy/client");
const { UpstreamClient } = await import("../../src/upstream/client");

let dateNowSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  CLIProxyClient.resetUsageEndpointSupportForTests();
});

afterEach(() => {
  dateNowSpy?.mockRestore();
  dateNowSpy = null;
  CLIProxyClient.resetUsageEndpointSupportForTests();
});

function queueRecord(index: number): Record<string, unknown> {
  return {
    timestamp: new Date(1_780_000_000_000 + index).toISOString(),
    latency_ms: 125,
    source: "acct@example.com",
    auth_index: "0",
    provider: "openai",
    model: "gpt-5.4-mini",
    endpoint: "POST /v1/chat/completions",
    api_key: "proxy",
    request_id: `req-${index}`,
    tokens: {
      input_tokens: 3,
      output_tokens: 4,
      reasoning_tokens: 0,
      cached_tokens: 0,
      total_tokens: 7,
    },
    failed: false,
  };
}

test("404 usage endpoint disables later correlation fetches", async () => {
  const fetchSpy = spyOn(UpstreamClient, "fetch").mockResolvedValue(new Response("not found", {
    status: 404,
    statusText: "Not Found",
  }));

  try {
    expect(await CLIProxyClient.fetchUsageFrom("http://localhost:8317/v0/management/usage", "test-mgmt-key")).toBeNull();
    expect(await CLIProxyClient.fetchUsageFrom("http://localhost:8317/v0/management/usage", "test-mgmt-key")).toBeNull();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0].url).toBe("http://localhost:8317/v0/management/usage");
  } finally {
    fetchSpy.mockRestore();
  }
});

test("fetchUsage prefers usage queue records over legacy usage snapshots", async () => {
  const fetchSpy = spyOn(UpstreamClient, "fetch").mockResolvedValue(new Response(JSON.stringify([queueRecord(1)]), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  try {
    const response = await CLIProxyClient.fetchUsageWithEndpoints("http://localhost:8317", "test-mgmt-key");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0].url).toBe("http://localhost:8317/v0/management/usage-queue?count=500");
    expect(fetchSpy.mock.calls[0][0].idempotent).toBe(false);
    expect(response?.usage.total_requests).toBe(1);
    const details = CLIProxyClient.flattenDetails(response!);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      model: "gpt-5.4-mini",
      source: "acct@example.com",
      auth_index: "0",
      latency_ms: 125,
      failed: false,
    });
    expect(details[0]?.tokens.total_tokens).toBe(7);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("fetchUsage drains multiple usage queue batches before returning", async () => {
  let calls = 0;
  const fetchSpy = spyOn(UpstreamClient, "fetch").mockImplementation(async () => {
    calls++;
    const batch = calls === 1
      ? Array.from({ length: 500 }, (_, index) => queueRecord(index))
      : [queueRecord(500)];
    return new Response(JSON.stringify(batch), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const response = await CLIProxyClient.fetchUsageWithEndpoints("http://localhost:8317", "test-mgmt-key");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(response?.usage.total_requests).toBe(501);
    expect(CLIProxyClient.flattenDetails(response!)).toHaveLength(501);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("fetchUsage returns an empty supported queue without legacy fallback", async () => {
  const fetchSpy = spyOn(UpstreamClient, "fetch").mockResolvedValue(new Response(JSON.stringify([]), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  try {
    const response = await CLIProxyClient.fetchUsageWithEndpoints("http://localhost:8317", "test-mgmt-key");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response?.usage.total_requests).toBe(0);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("fetchUsage caps usage queue draining under sustained backlog", async () => {
  const fetchSpy = spyOn(UpstreamClient, "fetch").mockImplementation(async () => new Response(JSON.stringify(
    Array.from({ length: 500 }, (_, index) => queueRecord(index)),
  ), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  try {
    const response = await CLIProxyClient.fetchUsageWithEndpoints("http://localhost:8317", "test-mgmt-key");
    expect(fetchSpy).toHaveBeenCalledTimes(20);
    expect(response?.usage.total_requests).toBe(10_000);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("fetchUsage falls back to legacy usage snapshots when usage queue is unavailable", async () => {
  const legacyResponse: CLIProxyClientNS.UsageResponse = {
    failed_requests: 0,
    usage: {
      total_requests: 1,
      success_count: 1,
      failure_count: 0,
      total_tokens: 5,
      apis: {
        proxy: {
          total_requests: 1,
          total_tokens: 5,
          models: {
            "gpt-5.4-mini": {
              total_requests: 1,
              total_tokens: 5,
              details: [{
                timestamp: "2026-06-05T00:00:00.000Z",
                latency_ms: 10,
                source: "acct@example.com",
                auth_index: "0",
                tokens: {
                  input_tokens: 2,
                  output_tokens: 3,
                  reasoning_tokens: 0,
                  cached_tokens: 0,
                  total_tokens: 5,
                },
                failed: false,
              }],
            },
          },
        },
      },
    },
  };
  const fetchSpy = spyOn(UpstreamClient, "fetch").mockImplementation(async (req: Parameters<typeof UpstreamClient.fetch>[0]) => {
    if (String(req.url).endsWith("/v0/management/usage-queue?count=500")) {
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }
    return new Response(JSON.stringify(legacyResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const response = await CLIProxyClient.fetchUsageWithEndpoints("http://localhost:8317", "test-mgmt-key");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0].url).toBe("http://localhost:8317/v0/management/usage");
    expect(fetchSpy.mock.calls[1][0].idempotent).toBe(true);
    expect(CLIProxyClient.flattenDetails(response!)).toHaveLength(1);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("usage queue unsupported cache retries after ttl", async () => {
  let now = 1_000;
  dateNowSpy = spyOn(Date, "now").mockImplementation(() => now);
  let calls = 0;
  const fetchSpy = spyOn(UpstreamClient, "fetch").mockImplementation(async () => {
    calls++;
    if (calls === 1) return new Response("not found", { status: 404, statusText: "Not Found" });
    return new Response(JSON.stringify([queueRecord(1)]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    expect(await CLIProxyClient.fetchUsageQueueFrom("http://localhost:8317/v0/management/usage-queue?count=500", "test-mgmt-key")).toBeNull();
    expect(await CLIProxyClient.fetchUsageQueueFrom("http://localhost:8317/v0/management/usage-queue?count=500", "test-mgmt-key")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 5 * 60 * 1000 + 1;
    const response = await CLIProxyClient.fetchUsageQueueFrom("http://localhost:8317/v0/management/usage-queue?count=500", "test-mgmt-key");
    expect(response?.usage.total_requests).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  } finally {
    fetchSpy.mockRestore();
  }
});
