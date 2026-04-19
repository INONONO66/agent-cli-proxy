import { createRequestContext } from "./requestContext";
import { handleOpenAIRequest } from "../providers/openai/adapter";

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
      // TODO: Wire up Anthropic adapter in Task 8
      return new Response(JSON.stringify({ error: "Not implemented" }), {
        status: 501,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/v1/chat/completions" && method === "POST") {
      return handleOpenAIRequest(req, ctx);
    }

    if (path.startsWith("/admin/")) {
      // TODO: Wire up admin routes in Task 12
      return new Response(JSON.stringify({ error: "Not implemented" }), {
        status: 501,
        headers: { "Content-Type": "application/json" },
      });
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
