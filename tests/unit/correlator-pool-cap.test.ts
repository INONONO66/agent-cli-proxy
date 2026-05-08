import { afterEach, expect, spyOn, test } from "bun:test";
import type { CLIProxyClient as CLIProxyClientNS } from "../../src/cliproxy/client";
import type { Usage } from "../../src/usage";

process.env.PROXY_LOCAL_OK = "1";
process.env.CLIPROXY_MGMT_KEY = "test-key";
process.env.CLIPROXY_CORRELATION_LOOKBACK_MS = "60000";

const { CLIProxyClient } = await import("../../src/cliproxy/client");
const { Correlator } = await import("../../src/cliproxy/correlator");
const { Storage } = await import("../../src/storage/db");
const { UsageService } = await import("../../src/storage/service");

function makeDetail(ts: string, totalTokens: number): CLIProxyClientNS.UsageDetail {
  return {
    timestamp: ts,
    latency_ms: 1_000,
    source: "acct",
    auth_index: "0",
    tokens: {
      input_tokens: Math.floor(totalTokens / 2),
      output_tokens: totalTokens - Math.floor(totalTokens / 2),
      reasoning_tokens: 0,
      cached_tokens: 0,
      total_tokens: totalTokens,
    },
    failed: false,
  };
}

function buildResponse(
  modelDetails: Record<string, CLIProxyClientNS.UsageDetail[]>,
): CLIProxyClientNS.UsageResponse {
  const models: Record<
    string,
    { total_requests: number; total_tokens: number; details: CLIProxyClientNS.UsageDetail[] }
  > = {};
  let total = 0;
  for (const [model, details] of Object.entries(modelDetails)) {
    models[model] = { total_requests: details.length, total_tokens: 0, details };
    total += details.length;
  }
  return {
    failed_requests: 0,
    usage: {
      total_requests: total,
      success_count: total,
      failure_count: 0,
      total_tokens: 0,
      apis: { anthropic: { total_requests: total, total_tokens: 0, models } },
    },
  };
}

function makeLog(
  id: number,
  model: string,
  startedAt: string,
  totalTokens: number,
): Usage.RequestLog {
  return {
    id,
    started_at: startedAt,
    model,
    total_tokens: totalTokens,
    latency_ms: 1_000,
    provider: "anthropic",
    tool: "test",
    client_id: "test",
    path: "/v1/messages",
    streamed: 0,
    prompt_tokens: Math.floor(totalTokens / 2),
    completion_tokens: totalTokens - Math.floor(totalTokens / 2),
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
    incomplete: 0,
  };
}

let fetchSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

function createService(
  response: CLIProxyClientNS.UsageResponse,
  logs: Usage.RequestLog[],
): { service: ReturnType<typeof UsageService.create>; applySpy: ReturnType<typeof spyOn> } {
  fetchSpy = spyOn(CLIProxyClient, "fetchUsage").mockResolvedValue(response);

  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);
  spyOn(service, "getUncorrelatedLogs").mockReturnValue(logs);
  const applySpy = spyOn(service, "applyCorrelation").mockImplementation(() => {});

  return { service, applySpy };
}

test("pool capped to 10,000 when details exceed limit", async () => {
  const now = new Date().toISOString();

  const slicedDetails = Array.from({ length: 10_000 }, () => makeDetail(now, 500));
  const keptDetails = Array.from({ length: 10_000 }, () => makeDetail(now, 1_000));

  const response = buildResponse({
    "sliced-model": slicedDetails,
    "kept-model": keptDetails,
  });

  const logs = [
    makeLog(1, "sliced-model", now, 500),
    makeLog(2, "kept-model", now, 1_000),
  ];

  const { service, applySpy } = createService(response, logs);
  await Correlator.runTick(service, { lookbackMs: 60_000 });

  expect(applySpy).toHaveBeenCalledTimes(1);
  expect(applySpy.mock.calls[0][0]).toBe(2);
});

test("details outside lookback window are excluded", async () => {
  const now = Date.now();
  const recentTs = new Date(now - 10_000).toISOString();
  const oldTs = new Date(now - 120_000).toISOString();

  const response = buildResponse({
    "test-model": [
      makeDetail(oldTs, 500),
      makeDetail(recentTs, 1_000),
    ],
  });

  const logs = [
    makeLog(1, "test-model", oldTs, 500),
    makeLog(2, "test-model", recentTs, 1_000),
  ];

  const { service, applySpy } = createService(response, logs);
  await Correlator.runTick(service, { lookbackMs: 60_000 });

  expect(applySpy).toHaveBeenCalledTimes(1);
  expect(applySpy.mock.calls[0][0]).toBe(2);
});

test("all details outside lookback returns early without matching", async () => {
  const oldTs = new Date(Date.now() - 120_000).toISOString();

  const response = buildResponse({
    "test-model": [makeDetail(oldTs, 500)],
  });

  const logs = [makeLog(1, "test-model", oldTs, 500)];
  const { service, applySpy } = createService(response, logs);
  await Correlator.runTick(service, { lookbackMs: 60_000 });

  expect(applySpy).not.toHaveBeenCalled();
});
