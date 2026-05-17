import type { AgentPlugin, RequestInfo } from "./types";

export const piPlugin: AgentPlugin = {
  id: "pi",

  matches(_info: RequestInfo): boolean {
    return false;
  },

  transformHeaders(headers: Headers): Headers {
    return headers;
  },
};
