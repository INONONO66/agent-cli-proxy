import { beforeEach, describe, expect, test } from "bun:test";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";

const { PerfMetrics } = await import("../../src/server/perf-metrics");
const { Metrics } = await import("../../src/server/metrics");
const { PassThroughProxy } = await import("../../src/server/pass-through");
const { Storage } = await import("../../src/storage/db");
const { UsageService } = await import("../../src/storage/service");
const { RequestInspector } = await import("../../src/server/request-inspector");
const { Pricing } = await import("../../src/storage/pricing");

beforeEach(() => {
  PerfMetrics.__resetForTests();
  Pricing.__setPricingForTests([
    ["openai/gpt-5.4-mini", { input: 1, output: 1, cache_read: 1, cache_write: 1, reasoning: 1 }],
    ["gpt-5.4-mini", { input: 1, output: 1, cache_read: 1, cache_write: 1, reasoning: 1 }],
  ]);
});

describe("performance metrics", () => {
  test("renders low-cardinality histograms for observed proxy and ready durations", () => {
    PerfMetrics.observeProxyRequest({
      provider: "openai",
      status: 200,
      lifecycleStatus: "completed",
      streamed: false,
      durationMs: 120.4,
    });
    PerfMetrics.observeReadyCheck({ status: "pass", durationMs: 7 });

    const output = PerfMetrics.renderPrometheus();

    expect(output).toContain("# TYPE agent_cli_proxy_proxy_request_duration_ms histogram");
    expect(output).toContain('agent_cli_proxy_proxy_request_duration_ms_bucket{le="250",lifecycle_status="completed",provider="openai",status="200",streamed="false"} 1');
    expect(output).toContain('agent_cli_proxy_proxy_request_duration_ms_count{lifecycle_status="completed",provider="openai",status="200",streamed="false"} 1');
    expect(output).toContain('agent_cli_proxy_ready_check_duration_ms_bucket{le="25",status="pass"} 1');
    expect(output).not.toContain("model=");
    expect(output).not.toContain("request_id=");
  });

  test("metrics endpoint output includes runtime performance hooks", () => {
    const db = Storage.initDb(":memory:");
    PerfMetrics.observeReadyCheck({ status: "fail", durationMs: 1_600 });

    const output = Metrics.render(db);

    expect(output).toContain("agent_cli_proxy_up 1");
    expect(output).toContain("agent_cli_proxy_ready_check_duration_ms_count");
    expect(output).toContain('status="fail"');
    db.close();
  });

  test("pass-through finalization records proxy request duration", async () => {
    const db = Storage.initDb(":memory:");
    const usageService = UsageService.create(db);
    const handle = PassThroughProxy.create(usageService, {
      fetch: async () => new Response(JSON.stringify({
        model: "gpt-5.4-mini",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const req = new Request("http://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "opencode/1.0" },
      body: JSON.stringify({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    const res = await handle(req, await RequestInspector.inspect(req));
    await res.text();

    const output = Metrics.render(db);
    expect(output).toContain('agent_cli_proxy_proxy_request_duration_ms_count{lifecycle_status="completed",provider="openai",status="200",streamed="false"} 1');
    db.close();
  });
});
