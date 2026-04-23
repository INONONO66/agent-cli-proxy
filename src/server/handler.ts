import { RequestInspector } from "./request-inspector";
import { PassThroughProxy } from "./pass-through";
import { Admin } from "../admin";
import { DashboardApi } from "../dashboard/api";
import type { UsageService } from "../storage/service";

export namespace Handler {
  export function create(usageService: UsageService.UsageService) {
    const passThrough = PassThroughProxy.create(usageService);
    const adminRouter = Admin.createRouter(usageService);
    const dashboardRouter = DashboardApi.createRouter(usageService);

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

      try {
        if (path.startsWith("/api/dashboard/")) {
          const dashboardResponse = await dashboardRouter(req);
          if (dashboardResponse) return dashboardResponse;
          return new Response("Not Found", { status: 404 });
        }

        if (path.startsWith("/admin/")) {
          const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
          const isLocal = !clientIp || clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "localhost";
          if (!isLocal) {
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
          const info = await RequestInspector.inspect(req);
          return passThrough(req, info);
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        console.error("[handleRequest] error:", err);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    };
  }
}
