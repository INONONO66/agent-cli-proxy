import { DashboardAuth } from "./auth";
import { Config } from "../config";
import type { UsageService } from "../storage/service";

export namespace DashboardApi {
  export function createRouter(usageService: UsageService) {
    return async function handleDashboardRequest(
      req: Request,
    ): Promise<Response | null> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (!path.startsWith("/api/dashboard/")) return null;

      const route = path.slice("/api/dashboard".length);

      // Auth routes — no middleware
      if (route === "/auth/login" && req.method === "POST") {
        return handleLogin(req);
      }
      if (route === "/auth/logout" && req.method === "POST") {
        return handleLogout();
      }
      if (route === "/auth/check" && req.method === "GET") {
        return handleAuthCheck(req);
      }

      // All other routes require auth
      const authResult = await DashboardAuth.authMiddleware(req);
      if (authResult) return authResult;

      // Usage routes
      if (route === "/usage/today" && req.method === "GET") {
        return json(usageService.getToday());
      }
      if (route === "/usage/range" && req.method === "GET") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to)
          return json({ error: "Missing from or to parameter" }, 400);
        return json(usageService.getDateRange(from, to));
      }
      if (route === "/usage/models" && req.method === "GET") {
        const day =
          url.searchParams.get("day") ??
          new Date().toISOString().slice(0, 10);
        return json(usageService.getModelBreakdown(day));
      }
      if (route === "/usage/stats" && req.method === "GET") {
        return json(usageService.getTotalStats());
      }
      if (route === "/usage/logs" && req.method === "GET") {
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? 50),
          200,
        );
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const tool = url.searchParams.get("tool");
        const clientId = url.searchParams.get("client_id");
        if (isNaN(limit) || isNaN(offset))
          return json({ error: "Invalid limit or offset" }, 400);
        return json(
          usageService.getRecentLogs(
            limit,
            offset,
            tool ?? undefined,
            clientId ?? undefined,
          ),
        );
      }

      const logsMatch = route.match(/^\/usage\/logs\/(\d+)$/);
      if (logsMatch && req.method === "GET") {
        const id = Number(logsMatch[1]);
        const data = usageService.getLogById(id);
        if (!data) return json({ error: "Not found" }, 404);
        return json(data);
      }

      // Metrics proxy (Prometheus)
      if (route === "/metrics/query" && req.method === "GET") {
        return proxyGet(
          Config.prometheusUrl,
          "/api/v1/query",
          url.searchParams,
        );
      }
      if (route === "/metrics/query_range" && req.method === "GET") {
        return proxyGet(
          Config.prometheusUrl,
          "/api/v1/query_range",
          url.searchParams,
        );
      }

      // Logs proxy (Loki)
      if (route === "/logs/query_range" && req.method === "GET") {
        return proxyGet(
          Config.lokiUrl,
          "/loki/api/v1/query_range",
          url.searchParams,
        );
      }

      // Health check
      if (route === "/health" && req.method === "GET") {
        return handleHealthCheck();
      }

      return null;
    };
  }

  async function handleLogin(req: Request): Promise<Response> {
    if (!DashboardAuth.isConfigured()) {
      return json({ error: "Dashboard not configured" }, 503);
    }

    let body: { username?: string; password?: string };
    try {
      body = (await req.json()) as { username?: string; password?: string };
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }

    const { username, password } = body;
    if (!username || !password) {
      return json({ error: "Missing username or password" }, 400);
    }

    if (username !== Config.dashboardUsername) {
      return json({ error: "Invalid credentials" }, 401);
    }

    const valid = await DashboardAuth.verifyPassword(password);
    if (!valid) {
      return json({ error: "Invalid credentials" }, 401);
    }

    const token = await DashboardAuth.createToken(username);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": DashboardAuth.createAuthCookie(token),
      },
    });
  }

  function handleLogout(): Response {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": DashboardAuth.createClearCookie(),
      },
    });
  }

  async function handleAuthCheck(req: Request): Promise<Response> {
    if (!DashboardAuth.isConfigured()) {
      return json({ authenticated: false, error: "Dashboard not configured" });
    }

    const token = DashboardAuth.extractToken(req);
    if (!token) {
      return json({ authenticated: false });
    }

    const user = await DashboardAuth.verifyToken(token);
    if (!user) {
      return json({ authenticated: false });
    }

    return json({ authenticated: true, username: user.username });
  }

  async function proxyGet(
    baseUrl: string,
    path: string,
    params: URLSearchParams,
  ): Promise<Response> {
    const target = `${baseUrl}${path}?${params.toString()}`;
    try {
      const upstream = await fetch(target, {
        signal: AbortSignal.timeout(5000),
      });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Upstream request failed";
      return json({ error: message }, 502);
    }
  }

  async function handleHealthCheck(): Promise<Response> {
    const checks = await Promise.allSettled([
      checkService(`${Config.prometheusUrl}/-/ready`),
      checkService(`${Config.lokiUrl}/ready`),
      checkService("http://localhost:9100/metrics"),
    ]);

    const services: Record<string, "up" | "down"> = {
      proxy: "up",
      prometheus: checks[0].status === "fulfilled" && checks[0].value ? "up" : "down",
      loki: checks[1].status === "fulfilled" && checks[1].value ? "up" : "down",
      node_exporter: checks[2].status === "fulfilled" && checks[2].value ? "up" : "down",
    };

    return json({ services });
  }

  async function checkService(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}
