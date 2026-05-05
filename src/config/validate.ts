import { readFileSync } from "node:fs";
import { validateProviderDocument } from "../provider/registry-schema";

export type EnvLike = Record<string, string | undefined>;

export interface ValidatedConfig {
  port: number;
  host: string;
  adminApiKey: string;
  cliProxyApiUrl: string;
  claudeCodeVersion: string;
  cchSalt: string;
  cchPositions: number[];
  toolPrefix: string;
  cliProxyApiKey: string;
  dbPath: string;
  pricingCacheTtlMs: number;
  pricingCachePath: string;
  readyPricingMaxAgeMs: number;
  pricingRefreshIntervalMs: number;
  costBackfillIntervalMs: number;
  costBackfillLookbackMs: number;
  logLevel: string;
  clientNameMapping: Map<string, string>;
  cliproxyMgmtKey: string;
  cliproxyCorrelationIntervalMs: number;
  cliproxyCorrelationLookbackMs: number;
  cliproxyAuthDir: string;
  quotaRefreshIntervalMs: number;
  quotaRefreshTimeoutMs: number;
  upstreamTimeoutMs: number;
  upstreamConnectTimeoutMs: number;
  maxRequestBodyBytes: number;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ValidateOptions {
  onWarning?: (issue: ConfigIssue) => void;
}

export class ConfigError extends Error {
  readonly name = "ConfigError";
  readonly code = "CONFIG_INVALID";

  constructor(readonly issues: ConfigIssue[]) {
    super(`Configuration validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
}

export namespace Config {
  export type Env = EnvLike;
  export type Issue = ConfigIssue;

  export function validate(env: EnvLike = process.env, options: ValidateOptions = {}): Readonly<ValidatedConfig> {
    const issues: ConfigIssue[] = [];
    const warnings: ConfigIssue[] = [];

    const host = readString(env, "PROXY_HOST", "127.0.0.1");
    const cliProxyApiUrl = readRequiredUrl(env, "CLI_PROXY_API_URL", issues, warnings);

    const config: ValidatedConfig = {
      port: readPort(env, issues),
      host,
      adminApiKey: readString(env, "ADMIN_API_KEY", ""),
      cliProxyApiUrl,
      claudeCodeVersion: readString(env, "CLAUDE_CODE_VERSION", "2.1.87"),
      cchSalt: readString(env, "CCH_SALT", "59cf53e54c78"),
      cchPositions: readCchPositions(env, issues),
      toolPrefix: readString(env, "TOOL_PREFIX", "mcp_"),
      cliProxyApiKey: readString(env, "CLI_PROXY_API_KEY", "proxy"),
      dbPath: readString(env, "DB_PATH", "data/proxy.db"),
      pricingCacheTtlMs: readPositiveNumber(env, "PRICING_CACHE_TTL_MS", 3600000, issues),
      pricingCachePath: readString(env, "PRICING_CACHE_PATH", "data/pricing-cache.json"),
      readyPricingMaxAgeMs: readPositiveNumber(env, "READY_PRICING_MAX_AGE_MS", 86400000, issues),
      pricingRefreshIntervalMs: readPositiveNumber(env, "PRICING_REFRESH_INTERVAL_MS", 21600000, issues),
      costBackfillIntervalMs: readPositiveNumber(env, "COST_BACKFILL_INTERVAL_MS", 1800000, issues),
      costBackfillLookbackMs: readPositiveNumber(env, "COST_BACKFILL_LOOKBACK_MS", 604800000, issues),
      logLevel: readString(env, "LOG_LEVEL", "info"),
      clientNameMapping: readClientNameMapping(env, issues),
      cliproxyMgmtKey: readString(env, "CLIPROXY_MGMT_KEY", ""),
      cliproxyCorrelationIntervalMs: readPositiveNumber(env, "CLIPROXY_CORRELATION_INTERVAL_MS", 15000, issues),
      cliproxyCorrelationLookbackMs: readPositiveNumber(env, "CLIPROXY_CORRELATION_LOOKBACK_MS", 300000, issues),
      cliproxyAuthDir: readString(env, "CLIPROXY_AUTH_DIR", ""),
      quotaRefreshIntervalMs: readPositiveNumber(env, "QUOTA_REFRESH_INTERVAL_MS", 300000, issues),
      quotaRefreshTimeoutMs: readPositiveNumber(env, "QUOTA_REFRESH_TIMEOUT_MS", 15000, issues),
      upstreamTimeoutMs: readPositiveNumber(env, "UPSTREAM_TIMEOUT_MS", 300000, issues),
      upstreamConnectTimeoutMs: readPositiveNumber(env, "UPSTREAM_CONNECT_TIMEOUT_MS", 10000, issues),
      maxRequestBodyBytes: readPositiveInteger(env, "MAX_REQUEST_BODY_BYTES", 25_000_000, 1_000_000_000, issues),
    };

    if (!isLoopbackHost(config.host) && !config.adminApiKey) {
      issues.push({
        path: "ADMIN_API_KEY",
        message: "is required when PROXY_HOST is not loopback",
      });
    }

    validateProviderConfig(env, issues);

    if (issues.length > 0) throw new ConfigError(issues);
    for (const warning of warnings) options.onWarning?.(warning);
    return Object.freeze(config);
  }
}

const DEFAULT_CLI_PROXY_API_URL = "http://localhost:8317";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function readString(env: EnvLike, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined ? fallback : value;
}

function readPort(env: EnvLike, issues: ConfigIssue[]): number {
  const raw = env.PROXY_PORT ?? "3100";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    issues.push({ path: "PROXY_PORT", message: "must be an integer from 1 to 65535" });
    return 3100;
  }
  return parsed;
}

function readPositiveNumber(env: EnvLike, key: string, fallback: number, issues: ConfigIssue[]): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    issues.push({ path: key, message: "must be a positive finite number" });
    return fallback;
  }
  return parsed;
}

function readPositiveInteger(
  env: EnvLike,
  key: string,
  fallback: number,
  maximum: number,
  issues: ConfigIssue[],
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    issues.push({ path: key, message: `must be an integer from 1 to ${maximum}` });
    return fallback;
  }
  return parsed;
}

function readRequiredUrl(
  env: EnvLike,
  key: "CLI_PROXY_API_URL",
  issues: ConfigIssue[],
  warnings: ConfigIssue[],
): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    if (env.PROXY_LOCAL_OK === "1") {
      warnings.push({
        path: key,
        message: `defaulted to ${DEFAULT_CLI_PROXY_API_URL} because PROXY_LOCAL_OK=1`,
      });
      return DEFAULT_CLI_PROXY_API_URL;
    }
    issues.push({ path: key, message: "is required unless PROXY_LOCAL_OK=1 permits the local default" });
    return DEFAULT_CLI_PROXY_API_URL;
  }
  return normalizeHttpUrl(raw, key, issues) ?? raw;
}

function normalizeHttpUrl(raw: string, path: string, issues: ConfigIssue[]): string | undefined {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      issues.push({ path, message: "must be an http(s) URL" });
      return undefined;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    issues.push({ path, message: "must be a parseable http(s) URL" });
    return undefined;
  }
}

function readCchPositions(env: EnvLike, issues: ConfigIssue[]): number[] {
  const raw = env.CCH_POSITIONS ?? "[4,7,20]";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.push({ path: "CCH_POSITIONS", message: "must be JSON array of finite non-negative integers" });
    return [4, 7, 20];
  }
  if (!Array.isArray(parsed)) {
    issues.push({ path: "CCH_POSITIONS", message: "must be an array" });
    return [4, 7, 20];
  }
  parsed.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0) {
      issues.push({ path: `CCH_POSITIONS[${index}]`, message: "must be a finite non-negative integer" });
    }
  });
  return parsed.filter((value): value is number => Number.isInteger(value) && value >= 0);
}

function readClientNameMapping(env: EnvLike, issues: ConfigIssue[]): Map<string, string> {
  const mapping = new Map<string, string>();
  const raw = env.CLIENT_NAME_MAPPING;
  if (raw === undefined || raw.trim() === "") return mapping;

  raw.split(",").forEach((entry, index) => {
    const pair = entry.trim();
    const splitAt = pair.indexOf("=");
    const key = splitAt >= 0 ? pair.slice(0, splitAt).trim() : "";
    const value = splitAt >= 0 ? pair.slice(splitAt + 1).trim() : "";
    if (!key || !value) {
      issues.push({ path: `CLIENT_NAME_MAPPING[${index}]`, message: "must be a non-empty key=value entry" });
      return;
    }
    mapping.set(key, value);
  });

  return mapping;
}

function validateProviderConfig(env: EnvLike, issues: ConfigIssue[]): void {
  const inline = env.PROVIDERS_JSON;
  const filePath = env.PROVIDERS_CONFIG_PATH;
  if (inline !== undefined && inline.trim() !== "") {
    validateProviderJson(inline, "PROVIDERS_JSON", issues);
    return;
  }
  if (filePath === undefined || filePath.trim() === "") return;

  try {
    validateProviderJson(readFileSync(filePath, "utf-8"), "PROVIDERS_CONFIG_PATH", issues);
  } catch (err) {
    issues.push({
      path: "PROVIDERS_CONFIG_PATH",
      message: `could not be read: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function validateProviderJson(raw: string, basePath: string, issues: ConfigIssue[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    issues.push({
      path: basePath,
      message: `must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const result = validateProviderDocument(parsed);
  issues.push(...result.issues);
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}
