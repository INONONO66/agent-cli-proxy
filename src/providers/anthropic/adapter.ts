import { config } from "../../config";
import type { RequestContext } from "../../server/requestContext";
import { relayStream } from "../../server/relayStream";
import type { TokenUsage } from "../../types/index";
import type { AnthropicRequest, AnthropicResponse } from "../../types/anthropic";
import {
  rewriteRequestBody,
  stripToolPrefix,
  stripToolPrefixFromLine,
} from "./transform";
import { buildClaudeCodeHeaders } from "./headers";

export async function handleAnthropicRequest(
  req: Request,
  ctx: RequestContext,
  onUsage?: (usage: TokenUsage) => void
): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = await req.json() as AnthropicRequest;
  } catch {
    return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid JSON body" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  body = rewriteRequestBody(body);

  const claudeHeaders = buildClaudeCodeHeaders();

  const upstreamReq = new Request(`${config.cliProxyApiUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...claudeHeaders,
    },
    body: JSON.stringify(body),
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamReq);
  } catch {
    return new Response(JSON.stringify({ error: { type: "api_error", message: "Failed to reach CLIProxyAPI" } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  if (body.stream === true) {
    return relayStream(upstreamResponse, {
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

  let responseJson: AnthropicResponse;
  try {
    responseJson = JSON.parse(responseText) as AnthropicResponse;
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
