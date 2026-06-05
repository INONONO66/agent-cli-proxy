import { Config } from "../config";
import { UpstreamClient } from "../upstream/client";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "cliproxy-client" });
const USAGE_QUEUE_BATCH_SIZE = 500;
let usageQueueUnsupported = false;
let usageEndpointUnsupported = false;

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
    return await fetchUsageWithEndpoints(Config.cliProxyApiUrl, Config.cliproxyMgmtKey);
  }

  export async function fetchUsageWithEndpoints(baseUrl: string, key: string): Promise<UsageResponse | null> {
    const queueResponse = await fetchUsageQueueFrom(
      `${baseUrl}/v0/management/usage-queue?count=${USAGE_QUEUE_BATCH_SIZE}`,
      key,
    );
    if (queueResponse) return queueResponse;
    return await fetchUsageFrom(`${baseUrl}/v0/management/usage`, key);
  }

  export async function fetchUsageQueueFrom(url: string, key: string): Promise<UsageResponse | null> {
    if (!key || usageQueueUnsupported) return null;

    try {
      const res = await UpstreamClient.fetch({
        method: "GET",
        url,
        headers: managementHeaders(key),
        providerId: "cliproxy-management",
        idempotent: true,
      });
      if (!res.ok) {
        await res.text().catch((err) => {
          logger.debug("usage queue fetch error body read failed", { err, status: res.status });
        });
        if (res.status === 404) {
          usageQueueUnsupported = true;
          logger.warn("usage queue endpoint unavailable, falling back to legacy usage endpoint", { status: res.status, status_text: res.statusText });
          return null;
        }
        logger.error("usage queue fetch failed", { status: res.status, status_text: res.statusText });
        return null;
      }

      return normalizeUsageQueueResponse(await res.json());
    } catch (err) {
      logger.error("usage queue fetch error", { err });
      return null;
    }
  }

  export async function fetchUsageFrom(url: string, key: string): Promise<UsageResponse | null> {
    if (!key || usageEndpointUnsupported) return null;

    try {
      const res = await UpstreamClient.fetch({
        method: "GET",
        url,
        headers: managementHeaders(key),
        providerId: "cliproxy-management",
        idempotent: true,
      });
      if (!res.ok) {
        await res.text().catch((err) => {
          logger.debug("usage fetch error body read failed", { err, status: res.status });
        });
        if (res.status === 404) {
          usageEndpointUnsupported = true;
          logger.warn("usage fetch endpoint unavailable, disabling correlation", { status: res.status, status_text: res.statusText });
          return null;
        }
        logger.error("usage fetch failed", { status: res.status, status_text: res.statusText });
        return null;
      }
      return (await res.json()) as UsageResponse;
    } catch (err) {
      logger.error("usage fetch error", { err });
      return null;
    }
  }

  export function resetUsageEndpointSupportForTests(): void {
    usageQueueUnsupported = false;
    usageEndpointUnsupported = false;
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

  function managementHeaders(key: string): Record<string, string> {
    return {
      Authorization: `Bearer ${key}`,
      "X-Management-Key": key,
    };
  }

  function normalizeUsageQueueResponse(raw: unknown): UsageResponse | null {
    if (!Array.isArray(raw)) return null;

    const response: UsageResponse = {
      failed_requests: 0,
      usage: {
        total_requests: 0,
        success_count: 0,
        failure_count: 0,
        total_tokens: 0,
        apis: {},
      },
    };

    for (const item of raw) {
      const record = normalizeUsageQueueRecord(item);
      if (!record) continue;
      const model = stringValue(record.model) || stringValue(record.alias) || "unknown";
      const api = stringValue(record.api_key) || stringValue(record.endpoint) || stringValue(record.provider) || "usage-queue";
      const failed = booleanValue(record.failed);
      const totalTokens = numberValue(record.tokens.total_tokens);
      const detail: UsageDetail = {
        timestamp: record.timestamp,
        latency_ms: numberValue(record.latency_ms),
        source: stringValue(record.source),
        auth_index: stringValue(record.auth_index),
        tokens: {
          input_tokens: numberValue(record.tokens.input_tokens),
          output_tokens: numberValue(record.tokens.output_tokens),
          reasoning_tokens: numberValue(record.tokens.reasoning_tokens),
          cached_tokens: numberValue(record.tokens.cached_tokens),
          total_tokens: totalTokens,
        },
        failed,
      };

      const apiStats = response.usage.apis[api] ??= { total_requests: 0, total_tokens: 0, models: {} };
      const modelStats = apiStats.models[model] ??= { total_requests: 0, total_tokens: 0, details: [] };
      modelStats.details.push(detail);
      modelStats.total_requests += 1;
      modelStats.total_tokens += totalTokens;
      apiStats.total_requests += 1;
      apiStats.total_tokens += totalTokens;
      response.usage.total_requests += 1;
      response.usage.total_tokens += totalTokens;
      if (failed) {
        response.failed_requests += 1;
        response.usage.failure_count += 1;
      } else {
        response.usage.success_count += 1;
      }
    }

    return response;
  }

  interface UsageQueueRecord {
    timestamp: string;
    latency_ms?: unknown;
    source?: unknown;
    auth_index?: unknown;
    provider?: unknown;
    model?: unknown;
    alias?: unknown;
    endpoint?: unknown;
    api_key?: unknown;
    tokens: Record<string, unknown>;
    failed?: unknown;
  }

  function normalizeUsageQueueRecord(item: unknown): UsageQueueRecord | null {
    const parsed = typeof item === "string" ? parseJsonObject(item) : item;
    if (!isRecord(parsed)) return null;
    const timestamp = stringValue(parsed.timestamp);
    if (!timestamp) return null;
    const tokens = isRecord(parsed.tokens) ? parsed.tokens : {};
    return { ...parsed, timestamp, tokens };
  }

  function parseJsonObject(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function stringValue(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  function numberValue(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  function booleanValue(value: unknown): boolean {
    return value === true;
  }
}
