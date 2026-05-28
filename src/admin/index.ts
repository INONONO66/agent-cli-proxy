import { UsageService } from "../storage/service";
import { Config } from "../config";
import { QuotaRepo, RequestRepo } from "../storage/repo";
import { Storage } from "../storage/db";
import { Logger } from "../util/logger";
import { UpstreamClient } from "../upstream/client";
import { ProviderRegistry } from "../provider/registry";
import { CanonicalProvider } from "../provider/canonical";
import { Pricing } from "../storage/pricing";
import { Session } from "./session";
import { OAuthAdmin } from "./oauth";
import { ApiKeysAdmin } from "./api-keys";
import { Usage } from "../usage";
import { dirname } from "path";
import { mkdirSync } from "fs";

const logger = Logger.fromConfig().child({ component: "admin" });
mkdirSync(dirname(Config.dbPath), { recursive: true });
const requestLogDb = Storage.initDb(Config.dbPath);

export namespace Admin {
  export interface SessionConfig {
    readonly passwordHash: string;
    readonly secret: string;
    readonly ttlMs: number;
    readonly trustProxyHeaders?: boolean;
  }

  export interface OAuthConfig {
    readonly authDir: string;
    readonly binaryPath: string;
    readonly configPath: string;
    readonly timeoutMs: number;
  }

  export function createRouter(
    usageService: UsageService.UsageService,
    sessionConfig: SessionConfig = { passwordHash: "", secret: "", ttlMs: 604800000, trustProxyHeaders: Config.trustProxyHeaders },
    oauthConfig: OAuthConfig = { authDir: "", binaryPath: "", configPath: "", timeoutMs: 300000 },
  ) {
    const oauthRouter = OAuthAdmin.createRouter(oauthConfig);
    const apiKeysRouter = ApiKeysAdmin.createRouter(usageService.db);

    return async function handleAdminRequest(req: Request): Promise<Response | null> {
      const url = new URL(req.url);
      const path = url.pathname;

      try {
        if (path === "/admin/breakers" && req.method === "GET") {
          return json({ breakers: UpstreamClient.getBreakerSnapshots() });
        }

        const breakerResetMatch = path.match(/^\/admin\/breakers\/([^/]+)\/reset$/);
        if (breakerResetMatch && req.method === "POST") {
          const providerId = decodeURIComponent(breakerResetMatch[1]);
          const ok = UpstreamClient.resetBreaker(providerId);
          if (!ok) return json({ error: "Breaker not found" }, 404);
          return json({ ok: true, providerId });
        }

        const breakerDetailMatch = path.match(/^\/admin\/breakers\/([^/]+)$/);
        if (breakerDetailMatch && req.method === "GET") {
          const providerId = decodeURIComponent(breakerDetailMatch[1]);
          const snap = UpstreamClient.getBreakerSnapshots().find((s) => s.providerId === providerId);
          if (!snap) return json({ error: "Breaker not found" }, 404);
          return json(snap);
        }

        if (path === "/admin/session/login" && req.method === "POST") {
          return Session.handleLogin(req, sessionConfig);
        }

        if (path === "/admin/session/logout" && req.method === "POST") {
          return Session.handleLogout(req, sessionConfig);
        }

        if (path === "/admin/session" && req.method === "GET") {
          return Session.handleCheck(req, sessionConfig);
        }

        const oauthResponse = await oauthRouter(req);
        if (oauthResponse) return oauthResponse;

        const apiKeysResponse = await apiKeysRouter(req);
        if (apiKeysResponse) return apiKeysResponse;

        if (req.method !== "GET") return null;
        if (path === "/admin/usage/today") {
          return json(usageService.getToday());
        }

        if (path === "/admin/usage/range") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          if (!from || !to)
            return json({ error: "Missing from or to parameter" }, 400);
          return json(usageService.getDateRange(from, to));
        }

        if (path === "/admin/usage/models") {
          const from = url.searchParams.get("from") ?? undefined;
          const to = url.searchParams.get("to") ?? undefined;
          if (from && to) {
            return json(usageService.getModelBreakdown(from, to));
          }
          const day =
            url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
          return json(usageService.getModelBreakdown(day));
        }

        if (path === "/admin/usage/providers") {
          const from = url.searchParams.get("from") ?? undefined;
          const to = url.searchParams.get("to") ?? undefined;
          if (from && to) {
            return json(usageService.getProviderBreakdown(from, to));
          }
          const day =
            url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
          return json(usageService.getProviderBreakdown(day));
        }

        if (path === "/admin/usage/accounts") {
          const day =
            url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
          return json(usageService.getAccountDaily(day));
        }

        if (path === "/admin/usage/accounts/range") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          if (!from || !to)
            return json({ error: "Missing from or to parameter" }, 400);
          return json(usageService.getAccountRange(from, to));
        }

        if (path === "/admin/usage/accounts/summary") {
          const from =
            url.searchParams.get("from") ??
            new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
          const to =
            url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
          return json(usageService.getAccountSummary(from, to));
        }

        if (path === "/admin/usage/trend") {
          const hours = Number(url.searchParams.get("hours") ?? 24);
          const from = url.searchParams.get("from") ?? undefined;
          const to = url.searchParams.get("to") ?? undefined;
          if (!Number.isFinite(hours) || hours <= 0) {
            return json({ error: "Invalid hours parameter" }, 400);
          }
          if ((from && !to) || (!from && to)) {
            return json({ error: "Both from and to are required when using date range" }, 400);
          }

          return json({
            buckets: RequestRepo.getTrend(usageService.db, {
              hours,
              from,
              to,
              provider: url.searchParams.get("provider") ?? undefined,
              model: url.searchParams.get("model") ?? undefined,
              tool: url.searchParams.get("tool") ?? undefined,
            }),
          });
        }

        if (path === "/admin/quotas" || path === "/admin/quotas/refresh") {
          const refresh = path.endsWith("/refresh") || url.searchParams.get("refresh") === "true";
          if (refresh) return json(await usageService.refreshQuotas());
          return json({ snapshots: usageService.getLatestQuotas() });
        }

        if (path === "/admin/quotas/history") {
          const hoursParam = url.searchParams.get("hours");
          const hours = hoursParam === null ? 24 : Number(hoursParam);
          if (!Number.isInteger(hours) || hours < 1) {
            return json({ error: "Invalid hours parameter" }, 400);
          }
          const from = url.searchParams.get("from") ?? undefined;
          const to = url.searchParams.get("to") ?? undefined;
          if ((from && !to) || (!from && to)) {
            return json({ error: "Both from and to are required when using date range" }, 400);
          }

          const provider = url.searchParams.get("provider") ?? undefined;
          const account = url.searchParams.get("account") ?? undefined;
          return json({
            buckets: QuotaRepo.getHistory(usageService.db, { hours, from, to, provider, account }),
          });
        }

        if (path === "/admin/stats") {
          return json(usageService.getTotalStats());
        }

        if (path === "/admin/providers") {
          const providers = ProviderRegistry.all().map((p) => ({
            id: p.id,
            type: p.type,
            paths: p.paths,
            models: p.models ?? [],
            hasCustomUpstream: p.upstreamBaseUrl !== Config.cliProxyApiUrl,
          }));
          return json({ providers, source: ProviderRegistry.sourceInfo() });
        }

        if (path === "/admin/pricing") {
          const freshness = await Pricing.getPricingFreshness();
          return json({
            loaded: freshness !== null,
            fetchedAt: freshness?.fetchedAt ?? null,
            ageMs: freshness?.ageMs ?? null,
            cachePath: Config.pricingCachePath,
          });
        }

        if (path === "/admin/config") {
          return json({
            proxy: {
              host: Config.host,
              port: Config.port,
              proxyRequireApiKey: Config.proxyRequireApiKey,
              trustProxyHeaders: Config.trustProxyHeaders,
            },
            upstream: {
              cliProxyApiUrl: Config.cliProxyApiUrl,
              timeoutMs: Config.upstreamTimeoutMs,
              connectTimeoutMs: Config.upstreamConnectTimeoutMs,
              maxRetries: Config.upstreamMaxRetries,
            },
            intervals: {
              pricingRefreshMs: Config.pricingRefreshIntervalMs,
              costBackfillMs: Config.costBackfillIntervalMs,
              quotaRefreshMs: Config.quotaRefreshIntervalMs,
            },
            features: {
              hasAdminApiKey: Boolean(Config.adminApiKey),
              hasMgmtKey: Boolean(Config.cliproxyMgmtKey),
              hasAuthDir: Boolean(Config.cliproxyAuthDir),
              hasDashboardPassword: Boolean(Config.dashboardPasswordHash),
            },
          });
        }

        if (path === "/admin/logs") {
          const limit = Math.min(
            Number(url.searchParams.get("limit") ?? 50),
            200,
          );
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const tool = url.searchParams.get("tool");
          const clientId = url.searchParams.get("client_id");
          const model = url.searchParams.get("model");
          const provider = url.searchParams.get("provider");
          const statusMin = parseOptionalInteger(url.searchParams.get("status_min"));
          const statusMax = parseOptionalInteger(url.searchParams.get("status_max"));
          const lifecycleStatus = parseLifecycleStatus(url.searchParams.get("lifecycle_status"));

          if (statusMin === null || statusMax === null || lifecycleStatus === null) {
            return json({ error: "Invalid filter parameter" }, 400);
          }
          if (!Number.isFinite(limit) || !Number.isFinite(offset) || limit < 1 || offset < 0)
            return json({ error: "Invalid limit or offset" }, 400);
          return json(RequestRepo.getRecent(requestLogDb, limit, offset, {
            tool: tool ?? undefined,
            clientId: clientId ?? undefined,
            model: model ?? undefined,
            provider: provider ?? undefined,
            statusMin,
            statusMax,
            lifecycleStatus,
          }));
        }

        const logsMatch = path.match(/^\/admin\/logs\/(\d+)$/);
        if (logsMatch) {
          const id = Number(logsMatch[1]);
          const data = usageService.getLogById(id);
          if (!data) return json({ error: "Not found" }, 404);
          return json(data);
        }

        return null;
      } catch (err) {
        logger.error("admin request failed", { err, path, method: req.method });
        return json({ error: "Internal server error" }, 500);
      }
    };
  }

  function parseOptionalInteger(value: string | null): number | null | undefined {
    if (value === null) return undefined;
    if (value === "") return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }

  function parseLifecycleStatus(value: string | null): Usage.LifecycleStatus | null | undefined {
    if (value === null || value === "") return undefined;
    if (value === "pending" || value === "completed" || value === "error" || value === "aborted") {
      return value;
    }
    return null;
  }

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}
