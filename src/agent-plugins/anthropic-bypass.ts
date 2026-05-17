import { Anthropic } from "../provider/anthropic";
import {
  rewriteRequestBody,
  stripToolPrefix,
  stripToolPrefixFromLine,
} from "../provider/anthropic/transform";
import type { RequestInfo } from "./types";

export function isAnthropicMessagesPath(path: string): boolean {
  return path.includes("messages");
}

export function anthropicBypassHeaders(headers: Headers, info: RequestInfo): Headers {
  if (!isAnthropicMessagesPath(info.path)) return headers;

  const result = new Headers(headers);
  for (const [key, value] of Object.entries(Anthropic.buildClaudeCodeHeaders())) {
    result.set(key, value);
  }
  return result;
}

export function anthropicBypassBody(body: unknown, info: RequestInfo): unknown {
  if (!isAnthropicMessagesPath(info.path)) return body;
  return rewriteRequestBody(body as Anthropic.Request);
}

export function anthropicBypassResponse(responseBody: string, info: RequestInfo): string {
  if (!isAnthropicMessagesPath(info.path)) return responseBody;

  try {
    return JSON.stringify(stripToolPrefix(JSON.parse(responseBody) as Anthropic.Response));
  } catch {
    return responseBody;
  }
}

export function anthropicBypassStreamLine(line: string, info: RequestInfo): string {
  if (!isAnthropicMessagesPath(info.path)) return line;
  return stripToolPrefixFromLine(line);
}
