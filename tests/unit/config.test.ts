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
  expect(config.cchPositions).toEqual([1, 2, 3]);
  expect(config.clientNameMapping).toBeInstanceOf(Map);
  expect(config.clientNameMapping.get("key1")).toBe("alice");
});

test("invalid port and timeout values fail fast", () => {
  const err = expectConfigError(() => Config.validate(baseEnv({
    PROXY_PORT: "65536",
    PRICING_CACHE_TTL_MS: "0",
    CLIPROXY_CORRELATION_INTERVAL_MS: "-1",
    CLIPROXY_CORRELATION_LOOKBACK_MS: "NaN",
    QUOTA_REFRESH_TIMEOUT_MS: "Infinity",
  })));

  expect(err.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
    "PROXY_PORT",
    "PRICING_CACHE_TTL_MS",
    "CLIPROXY_CORRELATION_INTERVAL_MS",
    "CLIPROXY_CORRELATION_LOOKBACK_MS",
    "QUOTA_REFRESH_TIMEOUT_MS",
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
