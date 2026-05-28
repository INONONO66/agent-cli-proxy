import { describe, expect, test } from "bun:test";
import { parsePerfBaselineArgs, renderMarkdown, summarizeSamples } from "../../scripts/perf-baseline";

describe("perf baseline script", () => {
  test("summarizes latency samples with stable percentiles", () => {
    const summary = summarizeSamples("health", "/health", [
      { status: 200, durationMs: 10 },
      { status: 200, durationMs: 20 },
      { status: 200, durationMs: 30 },
      { status: 200, durationMs: 40 },
    ]);

    expect(summary).toMatchObject({
      name: "health",
      path: "/health",
      ok: true,
      statuses: { "200": 4 },
      count: 4,
      minMs: 10,
      p50Ms: 20,
      p95Ms: 40,
      maxMs: 40,
      avgMs: 25,
    });
  });

  test("marks client and auth failures as unsuccessful samples", () => {
    const summary = summarizeSamples("metrics", "/metrics", [{ status: 403, durationMs: 5 }]);

    expect(summary).toMatchObject({
      ok: false,
      statuses: { "403": 1 },
    });
  });

  test("parses cli flags and environment defaults", () => {
    const options = parsePerfBaselineArgs([
      "--url", "http://proxy.test",
      "--admin-key", "secret",
      "--iterations", "5",
      "--warmup", "1",
      "--json",
    ], {} as NodeJS.ProcessEnv);

    expect(options).toEqual({
      baseUrl: "http://proxy.test",
      adminKey: "secret",
      iterations: 5,
      warmup: 1,
      json: true,
    });
  });

  test("renders a markdown report table", () => {
    const summary = summarizeSamples("ready", "/ready", [{ status: 503, durationMs: 123.456 }]);
    const report = renderMarkdown([summary], {
      baseUrl: "http://proxy.test",
      iterations: 1,
      warmup: 0,
      json: false,
    });

    expect(report).toContain("# Performance Baseline Report");
    expect(report).toContain("| ready (/ready) | 503×1 | 123.46 | 123.46 | 123.46 | 123.46 | 1 |");
  });
});
