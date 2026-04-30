import { Config } from "../../config";
import { Anthropic } from "./index";
import { RelayStream } from "../../server/relay-stream";
import { rewriteRequestBody, stripToolPrefix, stripToolPrefixFromLine } from "./transform";
import type { RequestContext } from "../../server/request-context";
import type { Usage } from "../../usage";

export async function handleAnthropicRequest(
  req: Request,
  ctx: RequestContext.Context,
  onUsage?: (usage: Usage.TokenUsage) => void,
): Promise<Response> {
  let body: Anthropic.Request;
  try {
    body = await req.json() as Anthropic.Request;
  } catch {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid JSON body" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  body = rewriteRequestBody(body);

  const claudeHeaders = Anthropic.buildClaudeCodeHeaders();

  const upstreamReq = new Request(`${Config.cliProxyApiUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${Config.cliProxyApiKey}`,
      ...claudeHeaders,
    },
    body: JSON.stringify(body),
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

  if (body.stream === true) {
    return RelayStream.relay(upstreamResponse, {
      provider: "anthropic",
      onUsage: onUsage ?? (() => {}),
      transformLine: stripToolPrefixFromLine,
    });
  }

  const responseText = await upstreamResponse.text();

  if (!upstreamResponse.ok) {
    return new Response(responseText, {
      status: upstreamResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  let responseJson: Anthropic.Response;
  try {
    responseJson = JSON.parse(responseText) as Anthropic.Response;
  } catch {
    return new Response(responseText, {
      status: upstreamResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  const strippedResponse = stripToolPrefix(responseJson);

  if (onUsage && strippedResponse.usage) {
    onUsage({
      prompt_tokens: strippedResponse.usage.input_tokens,
      completion_tokens: strippedResponse.usage.output_tokens,
      cache_creation_tokens: strippedResponse.usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: strippedResponse.usage.cache_read_input_tokens ?? 0,
      total_tokens: strippedResponse.usage.input_tokens + strippedResponse.usage.output_tokens,
      incomplete: false,
    });
  }

  return new Response(JSON.stringify(strippedResponse), {
    status: upstreamResponse.status,
    headers: { "content-type": "application/json" },
  });
}
