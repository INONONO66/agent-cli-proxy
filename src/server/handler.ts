import { timingSafeEqual } from "node:crypto";
import type { Server } from "bun";
import { RequestBodyTooLargeError, RequestInspector, isRequestBodyTooLargeError } from "./request-inspector";
import { PassThroughProxy, type ProxyAuthContext } from "./pass-through";
import { Metrics } from "./metrics";
import { Admin } from "../admin";
import { UsageService } from "../storage/service";
import { Config } from "../config";
import { Logger } from "../util/logger";
import { Pricing } from "../storage/pricing";
import { UpstreamClient } from "../upstream/client";
import { Supervisor } from "../runtime/supervisor";
import { Session } from "../admin/session";
import { PerfMetrics } from "./perf-metrics";
import { isRequestSecure } from "../util/proxy-headers";
import { ApiKeyRepo } from "../storage/api-keys";

const logger = Logger.fromConfig().child({ component: "handler" });
const readyLogger = logger.child({ component: "handler.ready" });
const encoder = new TextEncoder();

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

type RequestContext = Pick<Server<unknown>, "requestIP"> | undefined;

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
    sessionConfig?: Admin.SessionConfig;
    oauthConfig?: Admin.OAuthConfig;
    securityConfig?: Partial<SecurityConfig>;
  }

  interface SecurityConfig {
    adminApiKey: string;
    host: string;
    proxyRequireApiKey: boolean;
    trustProxyHeaders: boolean;
  }

  export function __clearReadyCacheForTests(): void {
    readyCache = null;
    readyInFlight = null;
  }

  export function create(usageService: UsageService.UsageService, options: Options = {}) {
    const passThrough = PassThroughProxy.create(usageService);
    const securityConfig: SecurityConfig = {
      adminApiKey: Config.adminApiKey,
      host: Config.host,
      proxyRequireApiKey: Config.proxyRequireApiKey,
      trustProxyHeaders: Config.trustProxyHeaders,
      ...options.securityConfig,
    };
    assertPublicProxyKeyInvariant(securityConfig);
    const sessionConfig: Admin.SessionConfig = {
      ...(options.sessionConfig ?? {
        passwordHash: Config.dashboardPasswordHash,
        secret: Config.dashboardSessionSecret,
        ttlMs: Config.dashboardSessionTtlMs,
      }),
      trustProxyHeaders: options.sessionConfig?.trustProxyHeaders ?? securityConfig.trustProxyHeaders,
    };
    const oauthConfig = options.oauthConfig ?? {
      authDir: Config.cliproxyAuthDir,
      binaryPath: Config.cliproxyBinaryPath,
      configPath: Config.cliproxyConfigPath,
      timeoutMs: Config.oauthJobTimeoutMs,
    };
    const adminRouter = Admin.createRouter(usageService, sessionConfig, oauthConfig);
    const maxRequestBodyBytes = options.maxRequestBodyBytes ?? Config.maxRequestBodyBytes;

    return async function handleRequest(req: Request, context?: RequestContext): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (path === "/health" && method === "GET") {
        return withSecurityHeaders(req, securityConfig, new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }

      if (path === "/ready" && method === "GET") {
        const result = await getReadyResult(usageService);
        return withSecurityHeaders(req, securityConfig, readyResponse(result));
      }

      if (path === "/metrics" && method === "GET") {
        if (!isLocalRequest(req, context)) return withSecurityHeaders(req, securityConfig, localOnlyResponse());

        const auth = await isAdminAuthorized(req, context, sessionConfig, securityConfig);
        if (!auth.authorized) {
          return withSecurityHeaders(req, securityConfig, new Response(JSON.stringify({ error: "Forbidden", code: "UNAUTHORIZED" }), {
            status: 403,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          }));
        }
        return withSecurityHeaders(req, securityConfig, new Response(Metrics.render(usageService.db), {
          status: 200,
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        }));
      }

      try {
        if (path.startsWith("/admin/")) {
          if (!isLocalRequest(req, context)) return withSecurityHeaders(req, securityConfig, localOnlyResponse());

          if (isSessionRoute(path)) {
            const sessionResponse = await adminRouter(req);
            if (sessionResponse) return withSecurityHeaders(req, securityConfig, sessionResponse);
          }

          const auth = await isAdminAuthorized(req, context, sessionConfig, securityConfig);
          if (!auth.authorized) {
            return withSecurityHeaders(req, securityConfig, new Response(JSON.stringify({ error: "Forbidden", code: "UNAUTHORIZED" }), {
              status: 403,
              headers: { "content-type": "application/json", "cache-control": "no-store" },
            }));
          }
          if (auth.viaCookie && requiresCsrf(req)) {
            return withSecurityHeaders(req, securityConfig, new Response(JSON.stringify({ error: "Forbidden", code: "CSRF_REQUIRED" }), {
              status: 403,
              headers: { "content-type": "application/json", "cache-control": "no-store" },
            }));
          }
          const adminResponse = await adminRouter(req);
          if (adminResponse) return withSecurityHeaders(req, securityConfig, adminResponse);
          return withSecurityHeaders(req, securityConfig, new Response("Not Found", { status: 404 }));
        }

        if (!path.startsWith("/v1/") && !path.startsWith("/api/")) {
          return withSecurityHeaders(req, securityConfig, new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }));
        }

        const proxyAuth = await enforceProxyApiKey(req, usageService, securityConfig);
        if (proxyAuth.response) {
          logger.warn("proxy request rejected: invalid API key", { event: "proxy.auth.rejected", path });
          return withSecurityHeaders(req, securityConfig, proxyAuth.response);
        }

        // Body limit enforcement only for methods that carry a body
        const needsBodyLimit = method === "POST" || method === "PUT" || method === "PATCH";
        const bounded = needsBodyLimit ? enforceRequestBodyLimit(req, maxRequestBodyBytes) : req;
        if (bounded instanceof Response) return withSecurityHeaders(req, securityConfig, bounded);
        const authContext = proxyAuth.context;
        if (!authContext) throw new Error("proxy auth context missing");
        const inspected = await RequestInspector.inspect(bounded);
        const info = authContext.mode === "resolved" ? { ...inspected, apiKey: null } : inspected;
        return withSecurityHeaders(req, securityConfig, passThrough(bounded, info, authContext));
      } catch (err) {
        if (isRequestBodyTooLargeError(err)) {
          return withSecurityHeaders(req, securityConfig, payloadTooLargeResponse(maxRequestBodyBytes));
        }
        logger.error("request handler failed", { err, path, method });
        return withSecurityHeaders(req, securityConfig, new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }));
      }
    };
  }

  async function enforceProxyApiKey(
    req: Request,
    usageService: UsageService.UsageService,
    securityConfig: SecurityConfig,
  ): Promise<{ response?: Response; context?: ProxyAuthContext }> {
    if (!securityConfig.proxyRequireApiKey) return undefinedProxyAuth();

    const proxyApiKey = extractProxyApiKey(req.headers);
    if (!proxyApiKey) return { response: proxyApiKeyRequiredResponse() };

    const found = await ApiKeyRepo.findByKeyFull(usageService.db, proxyApiKey);
    if (!found) return { response: proxyApiKeyRequiredResponse() };

    return {
      context: {
        mode: "resolved",
        proxyApiKey: { id: found.id, allowedProviders: found.allowedProviders, allowedAccounts: found.allowedAccounts },
      },
    };
  }

  function undefinedProxyAuth(): { context: ProxyAuthContext } {
    return { context: { mode: "best-effort-header" } };
  }

  function assertPublicProxyKeyInvariant(securityConfig: SecurityConfig): void {
    if (!isLoopbackHost(securityConfig.host) && !securityConfig.proxyRequireApiKey) {
      throw new Error("PROXY_REQUIRE_API_KEY must be true when PROXY_HOST is not loopback");
    }
  }

  function proxyApiKeyRequiredResponse(): Response {
    return new Response(JSON.stringify({ error: "Valid Authorization Bearer token or x-api-key required." }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  function extractProxyApiKey(headers: Headers): string | null {
    const authorization = headers.get("authorization")?.trim();
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    const bearer = match?.[1]?.trim();
    if (bearer) return bearer;
    const apiKey = headers.get("x-api-key")?.trim();
    return apiKey || null;
  }

  async function isAdminAuthorized(
    req: Request,
    context: RequestContext,
    sessionConfig: Admin.SessionConfig,
    securityConfig: SecurityConfig,
  ): Promise<{ authorized: boolean; viaCookie: boolean }> {
    if (!securityConfig.adminApiKey) {
      return { authorized: isLocalRequest(req, context), viaCookie: false };
    }

    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const token = req.headers.get("x-admin-token")?.trim() || bearer;
    if (token) return { authorized: constantTimeEqual(token, securityConfig.adminApiKey), viaCookie: false };

    const authorized = await Session.extractSession(req, sessionConfig.secret, sessionConfig.ttlMs);
    return { authorized, viaCookie: authorized };
  }

  function requiresCsrf(req: Request): boolean {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
    return req.headers.get("x-csrf") !== "1";
  }

  function isSessionRoute(path: string): boolean {
    return path === "/admin/session" || path === "/admin/session/login" || path === "/admin/session/logout";
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

  function withSecurityHeaders(
    req: Request,
    securityConfig: SecurityConfig,
    res: Response | Promise<Response>,
  ): Response | Promise<Response> {
    if (res instanceof Promise) {
      return res.then((resolved) => withSecurityHeaders(req, securityConfig, resolved)) as Promise<Response>;
    }
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("X-Content-Type-Options", "nosniff");
    res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    res.headers.set("X-Permitted-Cross-Domain-Policies", "none");
    if (isRequestSecure(req, securityConfig)) {
      res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return res;
  }

  function isLoopbackHost(host: string): boolean {
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  }

  function isLocalRequest(req: Request, context: RequestContext): boolean {
    const address = context?.requestIP(req)?.address;
    return address ? isLoopbackAddress(address) : false;
  }

  function isLoopbackAddress(address: string): boolean {
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }

  function localOnlyResponse(): Response {
    return new Response(JSON.stringify({ error: "Forbidden", code: "LOCAL_ONLY" }), {
      status: 403,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  function constantTimeEqual(left: string, right: string): boolean {
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    if (leftBytes.length !== rightBytes.length) return false;
    return timingSafeEqual(leftBytes, rightBytes);
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
    PerfMetrics.observeReadyCheck({ status: result.body.status, durationMs: result.durationMs });
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
