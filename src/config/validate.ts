import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  pricingOverrides: Record<string, PricingOverride>;
  pricingAliases: Record<string, string>;
  readyPricingMaxAgeMs: number;
  pricingRefreshIntervalMs: number;
  costBackfillIntervalMs: number;
  costBackfillLookbackMs: number;
  costBackfillChunkSize: number;
  logLevel: string;
  clientNameMapping: Map<string, string>;
  cliproxyMgmtKey: string;
  cliproxyCorrelationIntervalMs: number;
  cliproxyCorrelationLookbackMs: number;
  cliproxyAuthDir: string;
  dashboardPasswordHash: string;
  dashboardSessionSecret: string;
  dashboardSessionTtlMs: number;
  oauthJobTimeoutMs: number;
  cliproxyBinaryPath: string;
  cliproxyConfigPath: string;
  quotaRefreshIntervalMs: number;
  quotaRefreshTimeoutMs: number;
  upstreamTimeoutMs: number;
  upstreamStreamFirstByteTimeoutMs: number;
  upstreamConnectTimeoutMs: number;
  upstreamMaxRetries: number;
  upstreamCircuitBreakerOpenAfterFailures: number;
  upstreamCircuitBreakerHalfOpenAfterMs: number;
  upstreamCircuitBreakerEvictAfterMs: number;
  maxRequestBodyBytes: number;
  breakerOpenAfterFailures: number;
  breakerHalfOpenAfterMs: number;
  breakerEvictAfterMs: number;
  rateLimitMaxRetries: number;
  proxyRequireApiKey: boolean;
  trustProxyHeaders: boolean;
  loginRateLimitWindowMs: number;
  loginRateLimitMaxAttempts: number;
}

export interface PricingOverride {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
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
      dbPath: readString(env, "DB_PATH", defaultStatePath(env, "proxy.db")),
      pricingCacheTtlMs: readPositiveNumber(env, "PRICING_CACHE_TTL_MS", 3600000, issues),
      pricingCachePath: readString(env, "PRICING_CACHE_PATH", defaultStatePath(env, "pricing-cache.json")),
      pricingOverrides: readPricingOverrides(env, issues),
      pricingAliases: readPricingAliases(env, issues),
      readyPricingMaxAgeMs: readPositiveNumber(env, "READY_PRICING_MAX_AGE_MS", 86400000, issues),
      pricingRefreshIntervalMs: readPositiveNumber(env, "PRICING_REFRESH_INTERVAL_MS", 21600000, issues),
      costBackfillIntervalMs: readPositiveNumber(env, "COST_BACKFILL_INTERVAL_MS", 1800000, issues),
      costBackfillLookbackMs: readPositiveNumber(env, "COST_BACKFILL_LOOKBACK_MS", 604800000, issues),
      costBackfillChunkSize: readPositiveInteger(env, "COST_BACKFILL_CHUNK_SIZE", 500, 100_000, issues),
      logLevel: readString(env, "LOG_LEVEL", "info"),
      clientNameMapping: readClientNameMapping(env, issues),
      cliproxyMgmtKey: readString(env, "CLIPROXY_MGMT_KEY", ""),
      cliproxyCorrelationIntervalMs: readPositiveNumber(env, "CLIPROXY_CORRELATION_INTERVAL_MS", 15000, issues),
      cliproxyCorrelationLookbackMs: readPositiveNumber(env, "CLIPROXY_CORRELATION_LOOKBACK_MS", 300000, issues),
      cliproxyAuthDir: readString(env, "CLIPROXY_AUTH_DIR", ""),
      dashboardPasswordHash: readString(env, "DASHBOARD_PASSWORD_HASH", ""),
      dashboardSessionSecret: readString(env, "DASHBOARD_SESSION_SECRET", ""),
      dashboardSessionTtlMs: readPositiveNumber(env, "DASHBOARD_SESSION_TTL_MS", 604800000, issues),
      oauthJobTimeoutMs: readPositiveNumber(env, "OAUTH_JOB_TIMEOUT_MS", 300000, issues),
      cliproxyBinaryPath: readString(env, "CLIPROXY_BINARY_PATH", ""),
      cliproxyConfigPath: readString(env, "CLIPROXY_CONFIG_PATH", ""),
      quotaRefreshIntervalMs: readPositiveNumber(env, "QUOTA_REFRESH_INTERVAL_MS", 300000, issues),
      quotaRefreshTimeoutMs: readPositiveNumber(env, "QUOTA_REFRESH_TIMEOUT_MS", 15000, issues),
      upstreamTimeoutMs: readPositiveNumber(env, "UPSTREAM_TIMEOUT_MS", 300000, issues),
      upstreamStreamFirstByteTimeoutMs: readPositiveNumber(env, "UPSTREAM_STREAM_FIRST_BYTE_TIMEOUT_MS", 900000, issues),
      upstreamConnectTimeoutMs: readPositiveNumber(env, "UPSTREAM_CONNECT_TIMEOUT_MS", 10000, issues),
      upstreamMaxRetries: readPositiveInteger(env, "UPSTREAM_MAX_RETRIES", 2, 100, issues),
      upstreamCircuitBreakerOpenAfterFailures: readPositiveInteger(
        env,
        "UPSTREAM_CIRCUIT_BREAKER_OPEN_AFTER_FAILURES",
        5,
        1000,
        issues,
      ),
      upstreamCircuitBreakerHalfOpenAfterMs: readPositiveNumber(
        env,
        "UPSTREAM_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS",
        30000,
        issues,
      ),
      upstreamCircuitBreakerEvictAfterMs: readPositiveNumber(
        env,
        "UPSTREAM_CIRCUIT_BREAKER_EVICT_AFTER_MS",
        300000,
        issues,
      ),
      maxRequestBodyBytes: readPositiveInteger(env, "MAX_REQUEST_BODY_BYTES", 25_000_000, 1_000_000_000, issues),
      breakerOpenAfterFailures: readPositiveInteger(env, "UPSTREAM_CIRCUIT_BREAKER_OPEN_AFTER_FAILURES", 5, 1000, issues),
      breakerHalfOpenAfterMs: readPositiveNumber(env, "UPSTREAM_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS", 30_000, issues),
      breakerEvictAfterMs: readPositiveNumber(env, "UPSTREAM_CIRCUIT_BREAKER_EVICT_AFTER_MS", 300_000, issues),
      rateLimitMaxRetries: readPositiveInteger(env, "RATE_LIMIT_MAX_RETRIES", 3, 20, issues),
      proxyRequireApiKey: readBoolean(env, "PROXY_REQUIRE_API_KEY", !isLoopbackHost(host), issues),
      trustProxyHeaders: readBoolean(env, "TRUST_PROXY_HEADERS", false, issues),
      loginRateLimitWindowMs: readPositiveNumber(env, "LOGIN_RATE_LIMIT_WINDOW_MS", 60_000, issues),
      loginRateLimitMaxAttempts: readPositiveInteger(env, "LOGIN_RATE_LIMIT_MAX_ATTEMPTS", 5, 100, issues),
    };

    if (!isLoopbackHost(config.host) && !config.proxyRequireApiKey) {
      issues.push({
        path: "PROXY_REQUIRE_API_KEY",
        message: "must be true when PROXY_HOST is not loopback",
      });
    }

    warnForWeakSecret(warnings, "ADMIN_API_KEY", config.adminApiKey);
    warnForWeakSecret(warnings, "CLIPROXY_MGMT_KEY", config.cliproxyMgmtKey);
    warnForWeakSecret(warnings, "DASHBOARD_SESSION_SECRET", config.dashboardSessionSecret);
    if (!isLoopbackHost(config.host) || !isLoopbackUrl(config.cliProxyApiUrl)) warnForWeakSecret(warnings, "CLI_PROXY_API_KEY", config.cliProxyApiKey);
    warnForDeployStatePath(warnings, "DB_PATH", config.dbPath, env, { allowMemory: true });
    warnForDeployStatePath(warnings, "PRICING_CACHE_PATH", config.pricingCachePath, env);

    validateProviderConfig(env, issues);

    if (issues.length > 0) throw new ConfigError(issues);
    for (const warning of warnings) options.onWarning?.(warning);
    return Object.freeze(config);
  }
}

export const DEFAULT_CLI_PROXY_API_URL = "http://localhost:8317";

export interface CliProxyApiUrlOptions {
  allowLocalDefault?: boolean;
}

export function readCliProxyApiUrl(env: EnvLike, options: CliProxyApiUrlOptions = {}): string {
  const issues: ConfigIssue[] = [];
  const canDefault = options.allowLocalDefault === true && (env.CLI_PROXY_API_URL === undefined || env.CLI_PROXY_API_URL.trim() === "");
  const value = canDefault ? DEFAULT_CLI_PROXY_API_URL : readRequiredUrl(env, "CLI_PROXY_API_URL", issues, []);
  if (issues.length > 0) throw new ConfigError(issues);
  return value;
}

const APP_NAME = "agent-cli-proxy";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const DEFAULT_PRICING_OVERRIDES: Record<string, PricingOverride> = Object.freeze({
  "gpt-5.4": { input: 2.5, output: 15, cache_read: 0.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cache_read: 0.075 },
  "gpt-5.4-mini-2026-03-17": { input: 0.75, output: 4.5, cache_read: 0.075 },
  "kimi-for-coding": { input: 0.4, output: 2.5, cache_read: 0.4 },
  "kimi-k2": { input: 0.4, output: 2.5, cache_read: 0.4 },
  "kimi-k2.6": { input: 0.95, output: 4, cache_read: 0.16 },
});

const DEFAULT_PRICING_ALIASES: Record<string, string> = Object.freeze({
  "kimi-for-coding": "kimi-k2",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "gpt-5.4": "gpt-5.4",
});

function readString(env: EnvLike, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined ? fallback : value;
}

function defaultStatePath(env: EnvLike, filename: string): string {
  const explicitDataDir = env.AGENT_CLI_PROXY_DATA_DIR?.trim();
  if (explicitDataDir) return join(explicitDataDir, filename);

  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) return join(xdgDataHome, APP_NAME, filename);

  const home = env.HOME?.trim() || homedir();
  if (home) return join(home, ".local", "share", APP_NAME, filename);

  return join("data", filename);
}

function warnForDeployStatePath(
  warnings: ConfigIssue[],
  key: "DB_PATH" | "PRICING_CACHE_PATH",
  value: string,
  env: EnvLike,
  opts: { allowMemory?: boolean } = {},
): void {
  if (opts.allowMemory && value === ":memory:") return;
  if (!isAbsolute(value)) {
    warnings.push({
      path: key,
      message: "should be an absolute path outside the deploy/runtime directory to survive releases",
    });
    return;
  }

  for (const root of deployStateRoots(env)) {
    if (!isPathWithin(value, root)) continue;
    warnings.push({
      path: key,
      message: `should be outside deploy/runtime directory ${root} to survive releases`,
    });
    return;
  }
}

function deployStateRoots(env: EnvLike): string[] {
  return [
    env.AGENT_CLI_PROXY_RUNTIME_DIR,
    env.AGENT_CLI_PROXY_DEPLOY_DIR,
    process.cwd(),
    "/opt/agent-cli-proxy",
  ]
    .map((root) => root?.trim())
    .filter((root): root is string => typeof root === "string" && root.length > 0 && isAbsolute(root));
}

function isPathWithin(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolvedPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readBoolean(env: EnvLike, key: string, fallback: boolean, issues: ConfigIssue[]): boolean {
  const value = env[key];
  if (value === undefined) return fallback;
  const lower = value.trim().toLowerCase();
  if (lower === "1" || lower === "true" || lower === "yes") return true;
  if (lower === "0" || lower === "false" || lower === "no") return false;
  issues.push({ path: key, message: "must be a boolean (true/false, yes/no, or 1/0)" });
  return fallback;
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

function readPricingOverrides(env: EnvLike, issues: ConfigIssue[]): Record<string, PricingOverride> {
  const parsed = readJsonObject(env, "PRICING_OVERRIDES_JSON", issues);
  if (!parsed) return { ...DEFAULT_PRICING_OVERRIDES };

  const overrides: Record<string, PricingOverride> = {};
  for (const [model, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      issues.push({ path: `PRICING_OVERRIDES_JSON.${model}`, message: "must be a pricing object" });
      continue;
    }

    const input = value.input;
    const output = value.output;
    if (!isNonNegativeFiniteNumber(input) || !isNonNegativeFiniteNumber(output)) {
      issues.push({ path: `PRICING_OVERRIDES_JSON.${model}`, message: "must include non-negative numeric input and output" });
      continue;
    }

    const override: PricingOverride = { input, output };
    readOptionalPricingNumber(value, "cache_read", model, override, issues);
    readOptionalPricingNumber(value, "cache_write", model, override, issues);
    readOptionalPricingNumber(value, "reasoning", model, override, issues);
    overrides[model] = override;
  }

  return overrides;
}

function readOptionalPricingNumber(
  value: Record<string, unknown>,
  key: "cache_read" | "cache_write" | "reasoning",
  model: string,
  override: PricingOverride,
  issues: ConfigIssue[],
): void {
  const candidate = value[key];
  if (candidate === undefined) return;
  if (!isNonNegativeFiniteNumber(candidate)) {
    issues.push({ path: `PRICING_OVERRIDES_JSON.${model}.${key}`, message: "must be a non-negative finite number" });
    return;
  }
  override[key] = candidate;
}

function readPricingAliases(env: EnvLike, issues: ConfigIssue[]): Record<string, string> {
  const parsed = readJsonObject(env, "PRICING_ALIASES_JSON", issues);
  if (!parsed) return { ...DEFAULT_PRICING_ALIASES };

  const aliases: Record<string, string> = {};
  for (const [modelPrefix, target] of Object.entries(parsed)) {
    if (typeof target !== "string" || target.trim() === "") {
      issues.push({ path: `PRICING_ALIASES_JSON.${modelPrefix}`, message: "must be a non-empty string" });
      continue;
    }
    aliases[modelPrefix] = target.trim();
  }
  return aliases;
}

function readJsonObject(env: EnvLike, key: string, issues: ConfigIssue[]): Record<string, unknown> | null {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    issues.push({ path: key, message: `must be valid JSON: ${err instanceof Error ? err.message : String(err)}` });
    return null;
  }

  if (!isRecord(parsed)) {
    issues.push({ path: key, message: "must be a JSON object" });
    return null;
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase().replace(/^\[(.*)]$/, "$1"));
}

function isLoopbackUrl(raw: string): boolean {
  try {
    return isLoopbackHost(new URL(raw).hostname);
  } catch {
    return false;
  }
}

const WEAK_SECRET_VALUES = new Set(["admin", "changeme", "change-me", "default", "example", "password", "proxy", "secret", "token"]);

function warnForWeakSecret(warnings: ConfigIssue[], path: string, value: string): void {
  const normalized = value.trim().toLowerCase();
  if (!normalized || !WEAK_SECRET_VALUES.has(normalized)) return;
  warnings.push({ path, message: "uses a placeholder value; replace it with a unique random secret before exposure" });
}
