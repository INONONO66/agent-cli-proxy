export type { RequestInfo } from "../server/request-inspector";

import type { RequestInfo } from "../server/request-inspector";

export interface AgentPlugin {
  readonly id: string;
  matches(info: RequestInfo): boolean;
}
