import { relayStream } from "../../server/relayStream";
import type { RequestContext } from "../../server/requestContext";
import type { TokenUsage } from "../../types/index";

export async function handlePassthroughRequest(
  req: Request,
  ctx: RequestContext,
  onUsage?: (usage: TokenUsage) => void,
  upstreamBaseUrl?: string,
): Promise<Response> {
  if (!upstreamBaseUrl) {
    return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "No provider configured for this model" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const body = await req.text();
  const upstreamUrl = `${upstreamBaseUrl.replace(/\/+$/, "")}/chat/completions`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = req.headers.get("authorization");
  if (auth) headers["authorization"] = auth;
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) headers["x-api-key"] = apiKey;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(new Request(upstreamUrl, { method: "POST", headers, body }));
  } catch {
    return new Response(JSON.stringify({ error: { type: "api_error", message: `Failed to reach ${upstreamBaseUrl}` } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const isStreaming = body.includes('"stream":true') || body.includes('"stream": true');

  if (isStreaming) {
    return relayStream(upstreamResponse, {
      provider: "openai",
      onUsage: onUsage ?? (() => {}),
    });
  }

  const responseText = await upstreamResponse.text();

  if (onUsage) {
    try {
      const parsed = JSON.parse(responseText) as Record<string, unknown>;
      if (parsed.usage && typeof parsed.usage === "object") {
        const u = parsed.usage as Record<string, unknown>;
        onUsage({
          prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
          completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : 0,
          incomplete: false,
        });
      }
    } catch {}
  }

  return new Response(responseText, {
    status: upstreamResponse.status,
    headers: { "content-type": "application/json" },
  });
}
