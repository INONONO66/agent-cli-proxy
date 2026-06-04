import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "../../src/runtime/supervisor";

const DEFAULT_UPSTREAM_PORT = 18318;
const TEST_UPSTREAM_PORT = Number(process.env.READY_TEST_UPSTREAM_PORT ?? DEFAULT_UPSTREAM_PORT + (process.pid % 20_000));
const DEFAULT_UPSTREAM_URL = `http://127.0.0.1:${TEST_UPSTREAM_PORT}`;

type HandlerModule = typeof import("../../src/server/handler");
type StorageModule = typeof import("../../src/storage/db");
type UsageServiceModule = typeof import("../../src/storage/service");
type ConfigModule = typeof import("../../src/config");

type ReadyBody = {
  status: "pass" | "warn" | "fail";
  checks: {
    database?: { status?: string; responseTime?: number };
    pricing?: { status?: string; ageMs?: number; responseTime?: number; output?: string };
    upstream?: { status?: string; output?: string; responseTime?: number };
    supervisor?: {
      status?: string;
      loops?: string[];
      failedLoops?: Array<{ name: string; failed: boolean; consecutiveFailures: number }>;
      loopHealth?: Array<{
        name: string;
        lastSuccessAgeMs?: number;
        lastErrorAgeMs?: number;
        consecutiveFailures: number;
        status: "pass" | "warn" | "fail";
      }>;
    };
  };
};

describe("readiness endpoints", () => {
  let tempDir: string;
  let pricingCachePath: string;
  let db: Database;
  let handleRequest: (req: Request) => Promise<Response>;
  let Handler: HandlerModule["Handler"];
  let upstreamServer: ReturnType<typeof Bun.serve> | null = null;
  let upstreamPort = DEFAULT_UPSTREAM_PORT;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-cli-proxy-ready-"));
    pricingCachePath = join(tempDir, "pricing-cache.json");
    process.env.CLI_PROXY_API_URL = DEFAULT_UPSTREAM_URL;
    process.env.PROXY_LOCAL_OK = "1";
    process.env.DB_PATH = ":memory:";
    process.env.PRICING_CACHE_PATH = pricingCachePath;
    process.env.READY_PRICING_MAX_AGE_MS = "86400000";
    process.env.LOG_LEVEL = "error";

    const handlerModule: HandlerModule = await import("../../src/server/handler");
    const storageModule: StorageModule = await import("../../src/storage/db");
    const usageServiceModule: UsageServiceModule = await import("../../src/storage/service");
    const configModule: ConfigModule = await import("../../src/config");

    Handler = handlerModule.Handler;
    pricingCachePath = configModule.Config.pricingCachePath;
    upstreamPort = Number(new URL(configModule.Config.cliProxyApiUrl).port || "80");

    db = storageModule.Storage.initDb(":memory:");
    const usageService = usageServiceModule.UsageService.create(db);
    handleRequest = Handler.create(usageService);
  });

  beforeEach(async () => {
    await stopUpstream();
    Handler.__clearReadyCacheForTests();
    await writeFreshPricingCache();
  });

  afterAll(async () => {
    await stopUpstream();
    await Supervisor.stopAll();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("/health returns 200 with the backwards-compatible liveness body", async () => {
    const res = await handleRequest(new Request("http://proxy.local/health"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("/ready returns 200 when DB, pricing cache, upstream, and supervisor are healthy", async () => {
    await startUpstream(() => new Response(null, { status: 404 }));

    const res = await requestReady();
    const body = await readReadyBody(res);

    expect(res.status).toBe(200);
    expect(body.status).toBe("pass");
    expect(body.checks.database?.status).toBe("pass");
    expect(body.checks.pricing?.status).toBe("pass");
    expect(body.checks.upstream?.status).toBe("pass");
    expect(body.checks.supervisor?.status).toBe("pass");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("/ready response shape includes documented checks", async () => {
    await startUpstream(() => new Response(null, { status: 204 }));

    const res = await requestReady();
    const body = await readReadyBody(res);

    expect(body.checks).toBeDefined();
    expect(typeof body.checks.database?.responseTime).toBe("number");
    expect(typeof body.checks.pricing?.ageMs).toBe("number");
    expect(body.checks.upstream?.output).toContain("HTTP");
    expect(Array.isArray(body.checks.supervisor?.loops)).toBe(true);
  });

  test("/ready returns 503 when a loop has failed", async () => {
    await startUpstream(() => new Response(null, { status: 204 }));
    const handle = Supervisor.run("ready-failed-loop", () => {
      throw new Error("ready loop failed");
    }, {
      intervalMs: 10,
      jitterRatio: 0,
      maxConsecutiveFailures: 1,
    });

    try {
      await waitUntil(() => {
        return Supervisor.statuses().some((loop) => loop.name === "ready-failed-loop" && loop.failed);
      });

      const res = await requestReady();
      const body = await readReadyBody(res);

      expect(res.status).toBe(503);
      expect(body.checks.upstream?.status).toBe("pass");
      expect(body.checks.supervisor?.status).toBe("fail");
      expect(body.checks.supervisor?.loops).toContain("ready-failed-loop");
      expect(body.checks.supervisor?.failedLoops).toContainEqual({
        name: "ready-failed-loop",
        failed: true,
        consecutiveFailures: 1,
      });
    } finally {
      await handle.stop();
    }
  });

  test("/ready returns warn when a loop is in backoff but not failed", async () => {
    await startUpstream(() => new Response(null, { status: 204 }));
    const handle = Supervisor.run("ready-warn-loop", () => {
      throw new Error("temporary failure");
    }, {
      intervalMs: 100,
      jitterRatio: 0,
      maxConsecutiveFailures: 10,
    });

    try {
      await waitUntil(() => {
        return Supervisor.healthSnapshot().some((loop) => loop.name === "ready-warn-loop" && loop.status === "warn");
      });

      const res = await requestReady();
      const body = await readReadyBody(res);

      expect(res.status).toBe(200);
      expect(body.status).toBe("warn");
      expect(body.checks.supervisor?.status).toBe("warn");
      expect(body.checks.supervisor?.loops).toContain("ready-warn-loop");
      expect(body.checks.supervisor?.loopHealth).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "ready-warn-loop",
          status: "warn",
          consecutiveFailures: 1,
        }),
      ]));
    } finally {
      await handle.stop();
    }
  });

  test("/ready returns 503 when upstream is unreachable", async () => {
    const res = await requestReady();
    const body = await readReadyBody(res);

    expect(res.status).toBe(503);
    expect(body.status).toBe("fail");
    expect(body.checks.upstream?.status).toBe("fail");
  });

  test("/ready does not block beyond the readiness deadline when upstream hangs", async () => {
    await startUpstream(() => new Promise<Response>(() => {}));

    const startedAt = performance.now();
    const res = await requestReady();
    const durationMs = performance.now() - startedAt;

    expect(res.status).toBe(503);
    expect(durationMs).toBeLessThan(1_700);
  });

  test("/ready uses the memoized result for requests inside the cache window", async () => {
    let upstreamHits = 0;
    await startUpstream(() => {
      upstreamHits += 1;
      return new Response(null, { status: 204 });
    });

    const first = await requestReady();
    const second = await requestReady();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(upstreamHits).toBe(1);
  });

  test("/ready does not start overlapping checks while the prior readiness is draining", async () => {
    await startUpstream(() => new Response(null, { status: 204 }));
    let pricingCheckStarts = 0;
    type PricingCheckResult = { status: "pass" | "warn" | "fail"; responseTime?: number; ageMs?: number; output?: string };
    let resolvePricingCheck!: (result: PricingCheckResult) => void;

    const pendingPricingCheck = new Promise<PricingCheckResult>((resolve) => {
      resolvePricingCheck = resolve;
    });

    Handler.__setReadyDrainTimeoutForTests(5_000);
    Handler.__setReadyCheckOverrideForTests({
      pricing: async () => {
        pricingCheckStarts += 1;
        return pendingPricingCheck;
      },
    });

    const first = await requestReady();
    const firstBody = await readReadyBody(first);

    expect(first.status).toBe(503);
    expect(firstBody.status).toBe("fail");
    expect(firstBody.checks.pricing?.status).toBe("fail");
    expect(firstBody.checks.pricing?.output).toContain("pricing check timed out after 300ms");
    expect(pricingCheckStarts).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 3_200));

    const second = await requestReady();
    const secondBody = await readReadyBody(second);

    expect(secondBody.checks.pricing?.status).toBe("fail");
    expect(pricingCheckStarts).toBe(1);

    resolvePricingCheck({
      status: "pass",
      responseTime: 5,
      ageMs: 0,
      output: "pricing ready",
    });
    await pendingPricingCheck;
    Handler.__clearReadyCacheForTests();

    pricingCheckStarts = 0;
    Handler.__setReadyCheckOverrideForTests({
      pricing: async () => {
        pricingCheckStarts += 1;
        return { status: "pass", responseTime: 1, ageMs: 0 };
      },
    });

    await requestReady();

    expect(pricingCheckStarts).toBe(1);
  });

  test("/ready starts a fresh check after the drain deadline when prior checks do not settle", async () => {
    await startUpstream(() => new Response(null, { status: 204 }));
    let pricingCheckStarts = 0;
    type PricingCheckResult = { status: "pass" | "warn" | "fail"; responseTime?: number; ageMs?: number; output?: string };
    const pendingPricingCheck = new Promise<PricingCheckResult>(() => {});

    Handler.__setReadyDrainTimeoutForTests(50);
    Handler.__setReadyCheckOverrideForTests({
      pricing: async () => {
        pricingCheckStarts += 1;
        return pendingPricingCheck;
      },
    });

    const first = await requestReady();

    expect(first.status).toBe(503);
    expect(pricingCheckStarts).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 3_200));

    const second = await requestReady();
    const secondBody = await readReadyBody(second);

    expect(second.status).toBe(503);
    expect(secondBody.checks.pricing?.output).toContain("pricing check timed out after 300ms");
    expect(pricingCheckStarts).toBe(2);
  });

  test("/ready clear test helper prevents stale pending results from repopulating cache", async () => {
    await startUpstream(() => new Response(null, { status: 204 }));
    let pricingCheckStarts = 0;
    type PricingCheckResult = { status: "pass" | "warn" | "fail"; responseTime?: number; ageMs?: number; output?: string };
    const pendingPricingCheck = new Promise<PricingCheckResult>(() => {});

    Handler.__setReadyDrainTimeoutForTests(50);
    Handler.__setReadyCheckOverrideForTests({
      pricing: async () => {
        pricingCheckStarts += 1;
        return pendingPricingCheck;
      },
    });

    const first = requestReady();
    await waitUntil(() => pricingCheckStarts === 1);
    Handler.__clearReadyCacheForTests();

    expect((await first).status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 0));

    Handler.__setReadyCheckOverrideForTests({
      pricing: async () => {
        pricingCheckStarts += 1;
        return { status: "pass", responseTime: 1, ageMs: 0 };
      },
    });

    const second = await requestReady();

    expect(second.status).toBe(200);
    expect(pricingCheckStarts).toBe(2);
  });

  function requestReady(): Promise<Response> {
    return handleRequest(new Request("http://proxy.local/ready"));
  }

  async function readReadyBody(res: Response): Promise<ReadyBody> {
    return await res.json() as ReadyBody;
  }

  async function waitUntil(predicate: () => boolean, timeoutMs = 600): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timed out waiting for readiness condition");
  }

  async function writeFreshPricingCache(): Promise<void> {
    const fetchedAt = Date.now();
    if (!(await Bun.file(pricingCachePath).exists())) {
      await Bun.write(pricingCachePath, JSON.stringify({ fetchedAt, data: [["gpt-5.4", { input: 1, output: 1 }]] }));
    }
  }

  async function startUpstream(fetch: (req: Request) => Response | Promise<Response>): Promise<void> {
    upstreamServer = Bun.serve({ port: upstreamPort, idleTimeout: 0, fetch });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async function stopUpstream(): Promise<void> {
    if (!upstreamServer) return;
    upstreamServer.stop(true);
    upstreamServer = null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});
