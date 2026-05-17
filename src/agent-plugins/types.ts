export type { RequestInfo } from "../server/request-inspector";

import type { RequestInfo } from "../server/request-inspector";

export interface AgentPlugin {
  readonly id: string;
  matches(info: RequestInfo): boolean;
  transformHeaders(headers: Headers, info: RequestInfo): Headers;
  // Called only for non-streaming requests; if omitted, the body passes through unchanged.
  transformBody?(body: unknown, info: RequestInfo): unknown;
  // Called only for non-streaming text/json responses with the full body string; if omitted, the response passes through unchanged.
  transformResponse?(responseBody: string, info: RequestInfo): string;
  // Called per SSE data line during streaming relay; if omitted, the line passes through unchanged.
  transformStreamLine?(line: string, info: RequestInfo): string;
}
