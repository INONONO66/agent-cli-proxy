import { config } from "../../config";
import type { RequestContext } from "../../server/requestContext";
import { relayStream } from "../../server/relayStream";
import { finalizeOpenAIUsage, parseOpenAISSELine } from "./parseStreamUsage";
import type { TokenUsage } from "../../types/index";

export async function handleOpenAIRequest(
  req: Request,
  ctx: RequestContext,
  onUsage?: (usage: TokenUsage) => void
): Promise<Response> {
  const upstreamUrl = `${config.cliProxyApiUrl}/v1/chat/completions`;

  // Forward request body and headers to CLIProxyAPI
  const body = await req.text();
  const upstreamReq = new Request(upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Forward Authorization header if present
      ...(req.headers.get("authorization")
        ? { authorization: req.headers.get("authorization")! }
        : {}),
      ...(req.headers.get("x-api-key")
        ? { "x-api-key": req.headers.get("x-api-key")! }
        : {}),
    },
    body,
  });

  const upstreamResponse = await fetch(upstreamReq);

  // Check if streaming
  const isStreaming =
    body.includes('"stream":true') || body.includes('"stream": true');

  if (isStreaming) {
    return relayStream(upstreamResponse, {
      provider: "openai",
      onUsage: onUsage ?? (() => {}),
    });
  }

  // Non-streaming: extract usage from response JSON
  const responseText = await upstreamResponse.text();

  if (onUsage) {
    try {
      const responseJson = JSON.parse(responseText) as Record<string, unknown>;
      if (responseJson.usage && typeof responseJson.usage === "object") {
        const u = responseJson.usage as Record<string, unknown>;
        onUsage({
          prompt_tokens:
            typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
          completion_tokens:
            typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          total_tokens:
            typeof u.total_tokens === "number" ? u.total_tokens : 0,
          incomplete: false,
        });
      }
    } catch {
      // Ignore parse errors
    }
  }

  return new Response(responseText, {
    status: upstreamResponse.status,
    headers: { "content-type": "application/json" },
  });
}
