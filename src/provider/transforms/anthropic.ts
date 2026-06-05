import { Anthropic } from "../anthropic";
import {
  rewriteRequestBody,
  stripToolPrefix,
  stripToolPrefixFromLine,
} from "../anthropic/transform";
import { ProviderTransforms, type ProviderTransform } from "../transform";
import type { RequestInfo } from "../../server/request-inspector";

function isAnthropicMessagesPath(path: string): boolean {
  return path.includes("messages");
}

function anthropicBypassHeaders(headers: Headers, info: RequestInfo): Headers {
  if (!isAnthropicMessagesPath(info.path)) return headers;

  const result = new Headers(headers);
  for (const [key, value] of Object.entries(Anthropic.buildClaudeCodeHeaders())) {
    result.set(key, value);
  }
  return result;
}

function anthropicBypassBody(body: unknown, info: RequestInfo): unknown {
  if (!isAnthropicMessagesPath(info.path)) return body;
  return rewriteRequestBody(body as Anthropic.Request);
}

function anthropicBypassResponse(responseBody: string, info: RequestInfo): string {
  if (!isAnthropicMessagesPath(info.path)) return responseBody;

  try {
    return JSON.stringify(stripToolPrefix(JSON.parse(responseBody) as Anthropic.Response));
  } catch {
    return responseBody;
  }
}

function anthropicBypassStreamLine(line: string, info: RequestInfo): string {
  if (!isAnthropicMessagesPath(info.path)) return line;
  return stripToolPrefixFromLine(line);
}

const anthropicTransform: ProviderTransform = {
  providerId: "anthropic",
  transformHeaders: anthropicBypassHeaders,
  transformBody: anthropicBypassBody,
  transformResponse: anthropicBypassResponse,
  transformStreamLine: anthropicBypassStreamLine,
};

ProviderTransforms.register(anthropicTransform);
