import { createRequestContext } from "./requestContext";
import { handleOpenAIRequest } from "../providers/openai/adapter";
import { handleAnthropicRequest } from "../providers/anthropic/adapter";
import { withUsageLogging } from "./logUsage";
import { createAdminRouter } from "./routes/admin";
import { usageService } from "../services/index";

const anthropicHandler = withUsageLogging(handleAnthropicRequest);
const openaiHandler = withUsageLogging(handleOpenAIRequest);
const adminRouter = createAdminRouter(usageService);

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
      return anthropicHandler(req, ctx);
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
