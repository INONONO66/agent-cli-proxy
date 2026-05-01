import { Config } from "../../config";
import { RelayStream } from "../../server/relay-stream";
import { finalizeOpenAIUsage } from "./stream-usage";
import type { Usage } from "../../usage";

export async function handleOpenAIRequest(
  req: Request,
  ctx: { provider: string; path: string },
  onUsage?: (usage: Usage.TokenUsage) => void,
): Promise<Response> {
  const upstreamUrl = `${Config.cliProxyApiUrl}/v1/chat/completions`;

  const body = await req.text();
  const upstreamReq = new Request(upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(req.headers.get("authorization")
        ? { authorization: req.headers.get("authorization")! }
        : {}),
      ...(req.headers.get("x-api-key")
        ? { "x-api-key": req.headers.get("x-api-key")! }
        : {}),
    },
    body,
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamReq);
  } catch {
    return new Response(
      JSON.stringify({ error: { type: "api_error", message: "Failed to reach CLIProxyAPI" } }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  const isStreaming =
    body.includes('"stream":true') || body.includes('"stream": true');

  if (isStreaming) {
    return RelayStream.relay(upstreamResponse, {
      provider: "openai",
      onUsage: onUsage ?? (() => {}),
    });
  }

  const responseText = await upstreamResponse.text();

  if (onUsage) {
    try {
      const responseJson = JSON.parse(responseText) as Record<string, unknown>;
      if (responseJson.usage && typeof responseJson.usage === "object") {
        const u = responseJson.usage as Record<string, number>;
        onUsage({
          prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
          completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : 0,
          incomplete: false,
        });
      }
    } catch (err) {
      console.warn("[openai-adapter] usage parse failed:", err);
    }
  }

  return new Response(responseText, {
    status: upstreamResponse.status,
    headers: { "content-type": "application/json" },
  });
}
