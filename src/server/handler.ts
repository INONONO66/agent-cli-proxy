import { RequestInspector } from "./request-inspector";
import { PassThroughProxy } from "./pass-through";
import { Admin } from "../admin";
import { UsageService } from "../storage/service";
import { Config } from "../config";

export namespace Handler {
  export function create(usageService: UsageService.UsageService) {
    const passThrough = PassThroughProxy.create(usageService);
    const adminRouter = Admin.createRouter(usageService);

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

  function isAdminAuthorized(req: Request): boolean {
    if (!Config.adminApiKey) {
      return Config.host === "127.0.0.1" || Config.host === "localhost" || Config.host === "::1";
    }

    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const token = req.headers.get("x-admin-token")?.trim() || bearer;
    return token === Config.adminApiKey;
  }
}
