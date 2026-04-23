import { RequestContext } from "./request-context";
import { LogUsage } from "./log-usage";
import { handleAnthropicRequest } from "../provider/anthropic/adapter";
import { handleOpenAIRequest } from "../provider/openai/adapter";
import { Admin } from "../admin";
import { DashboardApi } from "../dashboard/api";
import type { UsageService } from "../storage/service";

function isClaude(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed.model === "string" && parsed.model.startsWith("claude");
  } catch {
    return false;
  }
}

export namespace Handler {
  export function create(usageService: UsageService.UsageService) {
    const anthropicHandler = LogUsage.withLogging(handleAnthropicRequest);
    const openaiHandler = LogUsage.withLogging(handleOpenAIRequest);
    const adminRouter = Admin.createRouter(usageService);
    const dashboardRouter = DashboardApi.createRouter(usageService);

    return async function handleRequest(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (path === "/health" && method === "GET") {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const ctx = RequestContext.create(req);

      try {
        if (path === "/v1/messages" && method === "POST") {
          const bodyText = await req.text();
          const rebuiltReq = new Request(req.url, { method: "POST", headers: req.headers, body: bodyText });

          if (isClaude(bodyText)) {
            return anthropicHandler(rebuiltReq, ctx);
          }

          return openaiHandler(rebuiltReq, ctx);
        }

        if (path === "/v1/chat/completions" && method === "POST") {
          return openaiHandler(req, ctx);
        }

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
              headers: { "Content-Type": "application/json" },
            });
          }
          const adminResponse = await adminRouter(req);
          if (adminResponse) return adminResponse;
          return new Response("Not Found", { status: 404 });
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        console.error("[handleRequest] error:", err);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    };
  }
}
