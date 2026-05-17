import type { AgentPlugin, RequestInfo } from "./types";
import { Anthropic } from "../provider/anthropic";
import {
  rewriteRequestBody,
  stripToolPrefix,
  stripToolPrefixFromLine,
} from "../provider/anthropic/transform";

function isAnthropicMessagesPath(path: string): boolean {
  return path.includes("messages");
}

export const openclawPlugin: AgentPlugin = {
  id: "openclaw",

  matches(info: RequestInfo): boolean {
    const userAgent = info.userAgent?.toLowerCase() ?? "";

    return Boolean(
      info.originator === "openclaw" ||
        info.agentName !== null ||
        userAgent.includes("openclaw-"),
    );
  },

  transformHeaders(headers: Headers, info: RequestInfo): Headers {
    if (!isAnthropicMessagesPath(info.path)) return headers;

    const result = new Headers(headers);
    for (const [key, value] of Object.entries(Anthropic.buildClaudeCodeHeaders())) {
      result.set(key, value);
    }
    return result;
  },

  transformBody(body: unknown, info: RequestInfo): unknown {
    if (!isAnthropicMessagesPath(info.path)) return body;
    return rewriteRequestBody(body as Anthropic.Request);
  },

  transformResponse(responseBody: string, info: RequestInfo): string {
    if (!isAnthropicMessagesPath(info.path)) return responseBody;

    try {
      return JSON.stringify(stripToolPrefix(JSON.parse(responseBody) as Anthropic.Response));
    } catch {
      return responseBody;
    }
  },

  transformStreamLine(line: string, info: RequestInfo): string {
    if (!isAnthropicMessagesPath(info.path)) return line;
    return stripToolPrefixFromLine(line);
  },
};
