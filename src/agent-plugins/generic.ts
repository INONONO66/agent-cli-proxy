import type { AgentPlugin } from "./types";
import type { RequestInfo } from "./types";

export const genericPlugin: AgentPlugin = {
  id: "generic",
  matches(_info: RequestInfo): boolean {
    return true;
  },
  transformHeaders(headers: Headers, _info: RequestInfo): Headers {
    return headers;
  },
};
