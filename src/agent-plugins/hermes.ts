import type { AgentPlugin, RequestInfo } from "./types";
import {
  anthropicBypassBody,
  anthropicBypassHeaders,
  anthropicBypassResponse,
  anthropicBypassStreamLine,
} from "./anthropic-bypass";

export const hermesPlugin: AgentPlugin = {
  id: "hermes",

  matches(info: RequestInfo): boolean {
    const userAgent = info.userAgent ?? "";
    return userAgent.includes("HermesAgent");
  },

  transformHeaders: anthropicBypassHeaders,
  transformBody: anthropicBypassBody,
  transformResponse: anthropicBypassResponse,
  transformStreamLine: anthropicBypassStreamLine,
};
