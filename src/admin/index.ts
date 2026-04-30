import { UsageService } from "../storage/service";

export namespace Admin {
  export function createRouter(usageService: UsageService.UsageService) {
    return async function handleAdminRequest(req: Request): Promise<Response | null> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method !== "GET") return null;

      try {
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
          const day =
            url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10);
          return json(usageService.getModelBreakdown(day));
        }

        if (path === "/admin/usage/providers") {
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

        if (path === "/admin/stats") {
          return json(usageService.getTotalStats());
        }

        if (path === "/admin/logs") {
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

        const logsMatch = path.match(/^\/admin\/logs\/(\d+)$/);
        if (logsMatch) {
          const id = Number(logsMatch[1]);
          const data = usageService.getLogById(id);
          if (!data) return json({ error: "Not found" }, 404);
          return json(data);
        }

        return null;
      } catch (err) {
        console.error("[admin] error:", err);
        return json({ error: "Internal server error" }, 500);
      }
    };
  }

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}
