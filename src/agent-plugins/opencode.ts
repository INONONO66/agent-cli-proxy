import type { AgentPlugin, RequestInfo } from "./types";
import {
  anthropicBypassBody,
  anthropicBypassHeaders,
  anthropicBypassResponse,
  anthropicBypassStreamLine,
} from "./anthropic-bypass";

export const opencodePlugin: AgentPlugin = {
  id: "opencode",

  matches(info: RequestInfo): boolean {
    const userAgent = info.userAgent?.toLowerCase() ?? "";

    return Boolean(
      info.sessionId?.startsWith("opencode-") ||
        info.originator === "opencode" ||
        userAgent.includes("opencode/") ||
        userAgent.includes("opencode-") ||
        userAgent.includes("openai-sdk-bun"),
    );
  },

  transformHeaders: anthropicBypassHeaders,
  transformBody: anthropicBypassBody,
  transformResponse: anthropicBypassResponse,
  transformStreamLine: anthropicBypassStreamLine,
};
