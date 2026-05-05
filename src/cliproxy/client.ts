import { Config } from "../config";
import { UpstreamClient } from "../upstream/client";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "cliproxy-client" });

export namespace CLIProxyClient {
  export interface UsageDetail {
    timestamp: string;
    latency_ms: number;
    source: string;
    auth_index: string;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      cached_tokens: number;
      total_tokens: number;
    };
    failed: boolean;
  }

  export interface UsageResponse {
    failed_requests: number;
    usage: {
      total_requests: number;
      success_count: number;
      failure_count: number;
      total_tokens: number;
      apis: Record<
        string,
        {
          total_requests: number;
          total_tokens: number;
          models: Record<
            string,
            {
              total_requests: number;
              total_tokens: number;
              details: UsageDetail[];
            }
          >;
        }
      >;
    };
  }

  export async function fetchUsage(): Promise<UsageResponse | null> {
    const key = Config.cliproxyMgmtKey;
    if (!key) return null;

    const url = `${Config.cliProxyApiUrl}/v0/management/usage`;
    try {
      const res = await UpstreamClient.fetch({
        method: "GET",
        url,
        headers: { Authorization: `Bearer ${key}` },
        providerId: "cliproxy-management",
        idempotent: true,
      });
      if (!res.ok) {
        logger.error("usage fetch failed", { status: res.status, status_text: res.statusText });
        return null;
      }
      return (await res.json()) as UsageResponse;
    } catch (err) {
      logger.error("usage fetch error", { err });
      return null;
    }
  }

  export function flattenDetails(
    response: UsageResponse,
  ): Array<UsageDetail & { model: string }> {
    const out: Array<UsageDetail & { model: string }> = [];
    for (const api of Object.values(response.usage.apis)) {
      for (const [modelName, modelStats] of Object.entries(api.models)) {
        for (const detail of modelStats.details) {
          out.push({ ...detail, model: modelName });
        }
      }
    }
    return out;
  }
}
