import type { AgentPlugin, RequestInfo } from "./types";
import {
  anthropicBypassBody,
  anthropicBypassHeaders,
  anthropicBypassResponse,
  anthropicBypassStreamLine,
} from "./anthropic-bypass";

export const genericPlugin: AgentPlugin = {
  id: "generic",
  matches(_info: RequestInfo): boolean {
    return true;
  },
  transformHeaders: anthropicBypassHeaders,
  transformBody: anthropicBypassBody,
  transformResponse: anthropicBypassResponse,
  transformStreamLine: anthropicBypassStreamLine,
};
