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

test("non-loopback host does not require admin API key", () => {
  const config = Config.validate(baseEnv({ PROXY_HOST: "0.0.0.0", ADMIN_API_KEY: "" }));

  expect(config.adminApiKey).toBe("");
  expect(config.proxyRequireApiKey).toBe(true);
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

test("pricing overrides and aliases parse from JSON env", () => {
  const config = Config.validate(baseEnv({
    PRICING_OVERRIDES_JSON: JSON.stringify({
      "local-model": { input: 1, output: 2, cache_read: 0.5 },
    }),
    PRICING_ALIASES_JSON: JSON.stringify({
      "local-model-preview": "local-model",
    }),
  }));

  expect(config.pricingOverrides["local-model"]).toEqual({ input: 1, output: 2, cache_read: 0.5 });
  expect(config.pricingAliases["local-model-preview"]).toBe("local-model");
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

test("invalid security booleans fail fast", () => {
  const err = expectConfigError(() => Config.validate(baseEnv({
    TRUST_PROXY_HEADERS: "treu",
    PROXY_REQUIRE_API_KEY: "maybe",
  })));

  expect(err.issues).toEqual(expect.arrayContaining([
    { path: "TRUST_PROXY_HEADERS", message: "must be a boolean (true/false, yes/no, or 1/0)" },
    { path: "PROXY_REQUIRE_API_KEY", message: "must be a boolean (true/false, yes/no, or 1/0)" },
  ]));
});

test("proxy API keys are required by default on non-loopback binds only", () => {
  const loopback = Config.validate(baseEnv({ PROXY_HOST: "127.0.0.1" }));
  expect(loopback.proxyRequireApiKey).toBe(false);

  const publicBind = Config.validate(baseEnv({
    PROXY_HOST: "0.0.0.0",
    ADMIN_API_KEY: "admin-token",
  }));
  expect(publicBind.proxyRequireApiKey).toBe(true);
});

test("non-loopback binds cannot disable proxy API keys", () => {
  const err = expectConfigError(() => Config.validate(baseEnv({
    PROXY_HOST: "0.0.0.0",
    ADMIN_API_KEY: "admin-token",
    PROXY_REQUIRE_API_KEY: "false",
  })));

  expect(err.issues).toContainEqual({
    path: "PROXY_REQUIRE_API_KEY",
    message: "must be true when PROXY_HOST is not loopback",
  });
});

test("placeholder secrets emit configuration warnings", () => {
  const warnings: Array<{ path: string; message: string }> = [];
  Config.validate(baseEnv({
    PROXY_HOST: "0.0.0.0",
    ADMIN_API_KEY: "admin",
    CLI_PROXY_API_KEY: "proxy",
    CLIPROXY_MGMT_KEY: "changeme",
    DASHBOARD_SESSION_SECRET: "secret",
  }), { onWarning: (issue) => warnings.push(issue) });

  expect(warnings.map((warning) => warning.path)).toEqual(expect.arrayContaining([
    "ADMIN_API_KEY",
    "CLI_PROXY_API_KEY",
    "CLIPROXY_MGMT_KEY",
    "DASHBOARD_SESSION_SECRET",
  ]));
});

test("placeholder upstream proxy key warns for non-loopback upstream URLs", () => {
  const warnings: Array<{ path: string; message: string }> = [];
  Config.validate(baseEnv({
    CLI_PROXY_API_URL: "https://cliproxy.example.test",
    CLI_PROXY_API_KEY: "proxy",
  }), { onWarning: (issue) => warnings.push(issue) });

  expect(warnings.map((warning) => warning.path)).toContain("CLI_PROXY_API_KEY");
});

test("IPv6 loopback upstream keeps local placeholder warning suppressed", () => {
  const warnings: Array<{ path: string; message: string }> = [];
  Config.validate(baseEnv({
    CLI_PROXY_API_URL: "http://[::1]:8317",
    CLI_PROXY_API_KEY: "proxy",
  }), { onWarning: (issue) => warnings.push(issue) });

  expect(warnings.map((warning) => warning.path)).not.toContain("CLI_PROXY_API_KEY");
});

test("default mutable state paths use the external XDG data directory", () => {
  const config = Config.validate(baseEnv({
    HOME: "/home/example",
    XDG_DATA_HOME: "/tmp/agent-cli-proxy-data",
  }));

  expect(config.dbPath).toBe("/tmp/agent-cli-proxy-data/agent-cli-proxy/proxy.db");
  expect(config.pricingCachePath).toBe("/tmp/agent-cli-proxy-data/agent-cli-proxy/pricing-cache.json");
});

test("AGENT_CLI_PROXY_DATA_DIR overrides default mutable state paths", () => {
  const config = Config.validate(baseEnv({
    AGENT_CLI_PROXY_DATA_DIR: "/srv/agent-cli-proxy-state",
    XDG_DATA_HOME: "/tmp/ignored-data-home",
  }));

  expect(config.dbPath).toBe("/srv/agent-cli-proxy-state/proxy.db");
  expect(config.pricingCachePath).toBe("/srv/agent-cli-proxy-state/pricing-cache.json");
});

test("relative mutable state paths emit deployment safety warnings", () => {
  const warnings: Config.Issue[] = [];

  Config.validate(baseEnv({
    DB_PATH: "data/proxy.db",
    PRICING_CACHE_PATH: "data/pricing-cache.json",
  }), { onWarning: (issue) => warnings.push(issue) });

  expect(warnings).toEqual(expect.arrayContaining([
    {
      path: "DB_PATH",
      message: "should be an absolute path outside the deploy/runtime directory to survive releases",
    },
    {
      path: "PRICING_CACHE_PATH",
      message: "should be an absolute path outside the deploy/runtime directory to survive releases",
    },
  ]));
});

test(":memory: DB skips deploy path warning", () => {
  const warnings: Config.Issue[] = [];

  Config.validate(baseEnv({
    DB_PATH: ":memory:",
    PRICING_CACHE_PATH: "/tmp/agent-cli-proxy/pricing-cache.json",
  }), { onWarning: (issue) => warnings.push(issue) });

  expect(warnings.map((warning) => warning.path)).not.toContain("DB_PATH");
});


test("absolute mutable state paths under deploy directories emit warnings", () => {
  const warnings: Config.Issue[] = [];

  Config.validate(baseEnv({
    DB_PATH: "/opt/agent-cli-proxy/data/proxy.db",
    PRICING_CACHE_PATH: "/opt/agent-cli-proxy/data/pricing-cache.json",
  }), { onWarning: (issue) => warnings.push(issue) });

  expect(warnings.map((warning) => warning.path)).toEqual(expect.arrayContaining([
    "DB_PATH",
    "PRICING_CACHE_PATH",
  ]));
  expect(warnings.map((warning) => warning.message).join(" ")).toContain("/opt/agent-cli-proxy");
});

test("absolute mutable state paths under configured runtime dir emit warnings", () => {
  const warnings: Config.Issue[] = [];

  Config.validate(baseEnv({
    AGENT_CLI_PROXY_RUNTIME_DIR: "/srv/agent-cli-proxy/runtime",
    DB_PATH: "/srv/agent-cli-proxy/runtime/data/proxy.db",
    PRICING_CACHE_PATH: "/var/cache/agent-cli-proxy/pricing-cache.json",
  }), { onWarning: (issue) => warnings.push(issue) });

  expect(warnings).toContainEqual({
    path: "DB_PATH",
    message: "should be outside deploy/runtime directory /srv/agent-cli-proxy/runtime to survive releases",
  });
  expect(warnings.map((warning) => warning.path)).not.toContain("PRICING_CACHE_PATH");
});
