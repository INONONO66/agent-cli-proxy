import { createRequestContext } from "./requestContext";
import { handleOpenAIRequest } from "../providers/openai/adapter";
import { handleAnthropicRequest } from "../providers/anthropic/adapter";
import { handlePassthroughRequest } from "../providers/passthrough/adapter";
import { routeByModel } from "../providers/router";
import { withUsageLogging } from "./logUsage";
import { createAdminRouter } from "./routes/admin";
import { usageService } from "../services/index";

const anthropicHandler = withUsageLogging(handleAnthropicRequest);
const openaiHandler = withUsageLogging(handleOpenAIRequest);
const adminRouter = createAdminRouter(usageService);

function extractModel(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (path === "/health" && method === "GET") {
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ctx = createRequestContext(req);

  try {
    if (path === "/v1/messages" && method === "POST") {
      const bodyText = await req.text();
      const model = extractModel(bodyText);

      if (!model) {
        return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Missing model field" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const route = routeByModel(model);
      const rebuiltReq = new Request(req.url, { method: "POST", headers: req.headers, body: bodyText });

      if (route.type === "claude") {
        return anthropicHandler(rebuiltReq, ctx);
      }

      return withUsageLogging((r, c, onUsage) =>
        handlePassthroughRequest(r, c, onUsage, route.baseUrl)
      )(rebuiltReq, ctx);
    }

    if (path === "/v1/chat/completions" && method === "POST") {
      return openaiHandler(req, ctx);
    }

    if (path.startsWith("/admin/")) {
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
}
