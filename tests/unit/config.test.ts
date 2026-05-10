import { expect, test } from "bun:test";
import { Config, ConfigError, type EnvLike } from "../../src/config/validate";

function baseEnv(overrides: EnvLike = {}): EnvLike {
  return {
    CLI_PROXY_API_URL: "http://localhost:8317",
    ...overrides,
  };
}

function expectConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("Expected ConfigError");
}

test("non-loopback host requires admin API key", () => {
  const err = expectConfigError(() => Config.validate(baseEnv({ PROXY_HOST: "0.0.0.0", ADMIN_API_KEY: "" })));

  expect(err.issues).toContainEqual({
    path: "ADMIN_API_KEY",
    message: "is required when PROXY_HOST is not loopback",
  });
});

test("missing CLI proxy upstream fails unless local fallback is explicit", () => {
  const err = expectConfigError(() => Config.validate({}));
  expect(err.issues.some((issue) => issue.path === "CLI_PROXY_API_URL")).toBe(true);

  const config = Config.validate({ PROXY_LOCAL_OK: "1" });
  expect(config.cliProxyApiUrl).toBe("http://localhost:8317");
});

test("invalid provider schema reports provider field path", () => {
  const err = expectConfigError(() => Config.validate(baseEnv({
    PROVIDERS_JSON: JSON.stringify({
      providers: [{
        type: "openai-compatible",
        paths: ["/v1/chat/completions"],
        upstreamBaseUrl: "https://example.com/api",
        auth: "none",
      }],
    }),
  })));

  expect(err.message).toContain("providers[0].id");
  expect(err.issues.some((issue) => issue.path === "providers[0].id")).toBe(true);
});

test("valid config is frozen and keeps typed values", () => {
  const config = Config.validate(baseEnv({
    PROXY_PORT: "4310",
    CCH_POSITIONS: "[1,2,3]",
    CLIENT_NAME_MAPPING: "key1=alice,key2=bob",
    UPSTREAM_MAX_RETRIES: "4",
    UPSTREAM_CIRCUIT_BREAKER_OPEN_AFTER_FAILURES: "12",
    UPSTREAM_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS: "45000",
    UPSTREAM_CIRCUIT_BREAKER_EVICT_AFTER_MS: "600000",
    PROVIDERS_JSON: JSON.stringify({
      providers: [{
        id: "local",
        type: "openai-compatible",
        paths: ["/v1/chat/completions"],
        upstreamBaseUrl: "http://localhost:11434",
        upstreamPath: "/v1/chat/completions",
        models: ["llama"],
        stripProviderField: true,
        headers: { "x-local": "yes" },
        auth: { type: "bearer", env: "LOCAL_API_KEY", header: "authorization" },
      }],
    }),
  }));

  expect(Object.isFrozen(config)).toBe(true);
  expect(config.port).toBe(4310);
  expect(config.maxRequestBodyBytes).toBe(25_000_000);
  expect(config.upstreamMaxRetries).toBe(4);
  expect(config.upstreamCircuitBreakerOpenAfterFailures).toBe(12);
  expect(config.upstreamCircuitBreakerHalfOpenAfterMs).toBe(45000);
  expect(config.upstreamCircuitBreakerEvictAfterMs).toBe(600000);
  expect(config.cchPositions).toEqual([1, 2, 3]);
  expect(config.clientNameMapping).toBeInstanceOf(Map);
  expect(config.clientNameMapping.get("key1")).toBe("alice");
});

test("request body limit accepts positive integers up to one billion bytes", () => {
  const config = Config.validate(baseEnv({ MAX_REQUEST_BODY_BYTES: "1000000000" }));

  expect(config.maxRequestBodyBytes).toBe(1_000_000_000);
});

test("invalid port and timeout values fail fast", () => {
  const err = expectConfigError(() => Config.validate(baseEnv({
    PROXY_PORT: "65536",
    PRICING_CACHE_TTL_MS: "0",
    PRICING_REFRESH_INTERVAL_MS: "-5",
    COST_BACKFILL_INTERVAL_MS: "0",
    COST_BACKFILL_LOOKBACK_MS: "NaN",
    CLIPROXY_CORRELATION_INTERVAL_MS: "-1",
    CLIPROXY_CORRELATION_LOOKBACK_MS: "NaN",
    QUOTA_REFRESH_INTERVAL_MS: "0",
    QUOTA_REFRESH_TIMEOUT_MS: "Infinity",
    READY_PRICING_MAX_AGE_MS: "0",
    UPSTREAM_MAX_RETRIES: "1.5",
    UPSTREAM_CIRCUIT_BREAKER_OPEN_AFTER_FAILURES: "0",
    UPSTREAM_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS: "NaN",
    UPSTREAM_CIRCUIT_BREAKER_EVICT_AFTER_MS: "-1",
    MAX_REQUEST_BODY_BYTES: "1000000001",
  })));

  expect(err.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
    "PROXY_PORT",
    "PRICING_CACHE_TTL_MS",
    "PRICING_REFRESH_INTERVAL_MS",
    "COST_BACKFILL_INTERVAL_MS",
    "COST_BACKFILL_LOOKBACK_MS",
    "CLIPROXY_CORRELATION_INTERVAL_MS",
    "CLIPROXY_CORRELATION_LOOKBACK_MS",
    "QUOTA_REFRESH_INTERVAL_MS",
    "QUOTA_REFRESH_TIMEOUT_MS",
    "READY_PRICING_MAX_AGE_MS",
    "UPSTREAM_MAX_RETRIES",
    "UPSTREAM_CIRCUIT_BREAKER_OPEN_AFTER_FAILURES",
    "UPSTREAM_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS",
    "UPSTREAM_CIRCUIT_BREAKER_EVICT_AFTER_MS",
    "MAX_REQUEST_BODY_BYTES",
  ]));
});

test("invalid URLs fail for upstream and provider config", () => {
  const err = expectConfigError(() => Config.validate(baseEnv({
    CLI_PROXY_API_URL: "ftp://localhost:8317",
    PROVIDERS_JSON: JSON.stringify({
      providers: [{
        id: "bad-url",
        type: "openai-compatible",
        paths: ["/v1/chat/completions"],
        upstreamBaseUrl: "not a url",
      }],
    }),
  })));

  expect(err.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
    "CLI_PROXY_API_URL",
    "providers[0].upstreamBaseUrl",
  ]));
});
