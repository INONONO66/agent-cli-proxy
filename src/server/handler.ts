import { RequestBodyTooLargeError, RequestInspector, isRequestBodyTooLargeError } from "./request-inspector";
import { PassThroughProxy } from "./pass-through";
import { Metrics } from "./metrics";
import { Admin } from "../admin";
import { UsageService } from "../storage/service";
import { Config } from "../config";
import { Logger } from "../util/logger";
import { Pricing } from "../storage/pricing";
import { UpstreamClient } from "../upstream/client";
import { Supervisor } from "../runtime/supervisor";

const logger = Logger.fromConfig().child({ component: "handler" });
const readyLogger = logger.child({ component: "handler.ready" });

type ReadyStatus = "pass" | "warn" | "fail";

type ReadyCheck = {
  status: ReadyStatus;
  responseTime?: number;
  output?: string;
  ageMs?: number;
  loops?: string[];
};

type ReadyChecks = {
  database: ReadyCheck;
  pricing: ReadyCheck;
  upstream: ReadyCheck;
  supervisor: ReadyCheck;
};

type ReadyBody = {
  status: ReadyStatus;
  checks: ReadyChecks;
};

type ReadyResult = {
  body: ReadyBody;
  httpStatus: number;
  durationMs: number;
};

const READY_TOTAL_TIMEOUT_MS = 1_500;
const READY_CACHE_TTL_MS = 3_000;
const READY_CHECK_TIMEOUTS_MS = {
  database: 300,
  pricing: 300,
  upstream: 1_000,
  supervisor: 300,
} as const;

let readyCache: { expiresAt: number; result: ReadyResult } | null = null;
let readyInFlight: Promise<ReadyResult> | null = null;

export namespace Handler {
  export interface Options {
    maxRequestBodyBytes?: number;
  }

  export function __clearReadyCacheForTests(): void {
    readyCache = null;
    readyInFlight = null;
  }

  export function create(usageService: UsageService.UsageService, options: Options = {}) {
    const passThrough = PassThroughProxy.create(usageService);
    const adminRouter = Admin.createRouter(usageService);
    const maxRequestBodyBytes = options.maxRequestBodyBytes ?? Config.maxRequestBodyBytes;

    return async function handleRequest(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (path === "/health" && method === "GET") {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (path === "/ready" && method === "GET") {
        const result = await getReadyResult(usageService);
        return readyResponse(result);
      }

      if (path === "/metrics" && method === "GET") {
        return new Response(Metrics.render(usageService.db), {
          status: 200,
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      }

      try {
        if (path.startsWith("/admin/")) {
          if (!isAdminAuthorized(req)) {
            return new Response(JSON.stringify({ error: "Forbidden" }), {
              status: 403,
              headers: { "content-type": "application/json" },
            });
          }
          const adminResponse = await adminRouter(req);
          if (adminResponse) return adminResponse;
          return new Response("Not Found", { status: 404 });
        }

        if ((path === "/v1/messages" || path === "/v1/chat/completions") && method === "POST") {
          const bounded = enforceRequestBodyLimit(req, maxRequestBodyBytes);
          if (bounded instanceof Response) return bounded;
          const info = await RequestInspector.inspect(bounded);
          return passThrough(bounded, info);
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        if (isRequestBodyTooLargeError(err)) {
          return payloadTooLargeResponse(maxRequestBodyBytes);
        }
        logger.error("request handler failed", { err, path, method });
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    };
  }

  function isAdminAuthorized(req: Request): boolean {
    if (!Config.adminApiKey) {
      return Config.host === "127.0.0.1" || Config.host === "localhost" || Config.host === "::1";
    }

    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const token = req.headers.get("x-admin-token")?.trim() || bearer;
    return token === Config.adminApiKey;
  }

  function enforceRequestBodyLimit(req: Request, limit: number): Request | Response {
    const contentLength = parseContentLength(req.headers.get("content-length"));
    if (contentLength !== null && contentLength > limit) return payloadTooLargeResponse(limit);
    if (!req.body) return req;

    return new Request(req, {
      body: req.body.pipeThrough(countBytes(limit)),
    });
  }

  function parseContentLength(raw: string | null): number | null {
    if (raw === null) return null;
    const parsed = Number(raw.trim());
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  function countBytes(limit: number): TransformStream<Uint8Array, Uint8Array> {
    let bytes = 0;
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > limit) {
          controller.error(new RequestBodyTooLargeError(limit));
          return;
        }
        controller.enqueue(chunk);
      },
    });
  }

  function payloadTooLargeResponse(limit: number): Response {
    return new Response(JSON.stringify({ error: `request body exceeds ${limit} bytes`, limit }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }

  function readyResponse(result: ReadyResult): Response {
    return new Response(JSON.stringify(result.body), {
      status: result.httpStatus,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  }

  async function getReadyResult(usageService: UsageService.UsageService): Promise<ReadyResult> {
    const now = Date.now();
    if (readyCache && readyCache.expiresAt > now) {
      readyLogger.debug("readiness cache hit", { event: "ready.cache_hit" });
      return readyCache.result;
    }

    if (readyInFlight) return readyInFlight;

    readyInFlight = computeReadyResult(usageService).then((result) => {
      readyCache = { result, expiresAt: Date.now() + READY_CACHE_TTL_MS };
      return result;
    }).finally(() => {
      readyInFlight = null;
    });

    return readyInFlight;
  }

  async function computeReadyResult(usageService: UsageService.UsageService): Promise<ReadyResult> {
    const startedAt = Date.now();
    const result = await raceWithDeadline(runReadyChecks(usageService), startedAt);
    readyLogger.info("readiness checked", {
      event: "ready.check",
      status: result.body.status,
      duration_ms: result.durationMs,
      checks: result.body.checks,
    });
    return result;
  }

  async function raceWithDeadline(checks: Promise<ReadyChecks>, startedAt: number): Promise<ReadyResult> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<ReadyChecks>((resolve) => {
        timer = setTimeout(() => resolve(timeoutChecks()), READY_TOTAL_TIMEOUT_MS);
      });
      const readyChecks = await Promise.race([checks, timeout]);
      const status = aggregateStatus(readyChecks);
      return {
        body: { status, checks: readyChecks },
        httpStatus: status === "fail" ? 503 : 200,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function runReadyChecks(usageService: UsageService.UsageService): Promise<ReadyChecks> {
    const [database, pricing, upstream, supervisor] = await Promise.all([
      withCheckTimeout("database", () => checkDatabase(usageService), READY_CHECK_TIMEOUTS_MS.database),
      withCheckTimeout("pricing", checkPricing, READY_CHECK_TIMEOUTS_MS.pricing),
      withCheckTimeout("upstream", checkUpstream, READY_CHECK_TIMEOUTS_MS.upstream),
      withCheckTimeout("supervisor", checkSupervisor, READY_CHECK_TIMEOUTS_MS.supervisor),
    ]);

    return { database, pricing, upstream, supervisor };
  }

  async function withCheckTimeout(
    name: keyof ReadyChecks,
    check: () => Promise<ReadyCheck> | ReadyCheck,
    timeoutMs: number,
  ): Promise<ReadyCheck> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    try {
      return await Promise.race([
        Promise.resolve().then(check),
        new Promise<ReadyCheck>((resolve) => {
          timer = setTimeout(() => resolve({
            status: "fail",
            output: `${name} check timed out after ${timeoutMs}ms`,
            responseTime: Date.now() - startedAt,
          }), timeoutMs);
        }),
      ]);
    } catch (err) {
      return {
        status: "fail",
        output: err instanceof Error ? err.message : String(err),
        responseTime: Date.now() - startedAt,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function checkDatabase(usageService: UsageService.UsageService): ReadyCheck {
    const startedAt = Date.now();
    const row = usageService.db.prepare("SELECT 1 AS ok").get() as { ok: number } | null;
    if (row?.ok !== 1) {
      return { status: "fail", responseTime: Date.now() - startedAt, output: "SELECT 1 returned no row" };
    }
    return { status: "pass", responseTime: Date.now() - startedAt };
  }

  async function checkPricing(): Promise<ReadyCheck> {
    const startedAt = Date.now();
    const fileExists = await Bun.file(Config.pricingCachePath).exists();
    if (!fileExists) {
      return {
        status: "fail",
        responseTime: Date.now() - startedAt,
        output: `pricing cache missing at ${Config.pricingCachePath}`,
      };
    }

    const freshness = await Pricing.getPricingFreshness();
    if (!freshness) {
      return { status: "fail", responseTime: Date.now() - startedAt, output: "pricing cache not loaded" };
    }

    if (freshness.ageMs >= Config.readyPricingMaxAgeMs) {
      return {
        status: "fail",
        ageMs: freshness.ageMs,
        responseTime: Date.now() - startedAt,
        output: `pricing cache older than ${Config.readyPricingMaxAgeMs}ms`,
      };
    }

    return { status: "pass", ageMs: freshness.ageMs, responseTime: Date.now() - startedAt };
  }

  async function checkUpstream(): Promise<ReadyCheck> {
    const startedAt = Date.now();
    const upstreamHealthUrl = `${Config.cliProxyApiUrl.replace(/\/+$/, "")}/health`;
    const signal = AbortSignal.timeout(READY_CHECK_TIMEOUTS_MS.upstream);
    const response = await UpstreamClient.fetch({
      method: "HEAD",
      url: upstreamHealthUrl,
      providerId: "ready-probe",
      idempotent: false,
      signal,
    });
    const responseTime = Date.now() - startedAt;
    const output = `HTTP ${response.status}`;
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 500) return { status: "pass", output, responseTime };
    return { status: "fail", output, responseTime };
  }

  function checkSupervisor(): ReadyCheck {
    const loops = Supervisor.list();
    return { status: "pass", loops };
  }

  function aggregateStatus(checks: ReadyChecks): ReadyStatus {
    const statuses = Object.values(checks).map((check) => check.status);
    if (statuses.includes("fail")) return "fail";
    if (statuses.includes("warn")) return "warn";
    return "pass";
  }

  function timeoutChecks(): ReadyChecks {
    const timedOut: ReadyCheck = {
      status: "fail",
      output: `readiness deadline exceeded after ${READY_TOTAL_TIMEOUT_MS}ms`,
      responseTime: READY_TOTAL_TIMEOUT_MS,
    };
    return {
      database: timedOut,
      pricing: timedOut,
      upstream: timedOut,
      supervisor: timedOut,
    };
  }
}
