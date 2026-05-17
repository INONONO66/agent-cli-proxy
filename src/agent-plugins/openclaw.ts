import type { AgentPlugin, RequestInfo } from "./types";
import {
  anthropicBypassBody,
  anthropicBypassHeaders,
  anthropicBypassResponse,
  anthropicBypassStreamLine,
} from "./anthropic-bypass";

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

  transformHeaders: anthropicBypassHeaders,
  transformBody: anthropicBypassBody,
  transformResponse: anthropicBypassResponse,
  transformStreamLine: anthropicBypassStreamLine,
};
