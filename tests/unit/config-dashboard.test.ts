import { expect, test, describe } from "bun:test";
import { Config } from "../../src/config/validate";

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CLI_PROXY_API_URL: "http://localhost:8317",
    ...overrides,
  };
}

describe("dashboard config defaults", () => {
  test("validates without dashboard env vars", () => {
    const config = Config.validate(env());

    expect(config.dashboardPasswordHash).toBe("");
    expect(config.dashboardSessionSecret).toBe("");
    expect(config.dashboardSessionTtlMs).toBe(604_800_000);
    expect(config.oauthJobTimeoutMs).toBe(300_000);
    expect(config.cliproxyBinaryPath).toBe("");
    expect(config.cliproxyConfigPath).toBe("");
  });
});

describe("dashboard config env parsing", () => {
  test("parses custom dashboard values", () => {
    const config = Config.validate(env({
      DASHBOARD_PASSWORD_HASH: "$2b$10$hash",
      DASHBOARD_SESSION_SECRET: "session-secret",
      DASHBOARD_SESSION_TTL_MS: "123456",
      OAUTH_JOB_TIMEOUT_MS: "654321",
      CLIPROXY_BINARY_PATH: "/opt/cliproxy",
      CLIPROXY_CONFIG_PATH: "/opt/cliproxy/config.json",
    }));

    expect(config.dashboardPasswordHash).toBe("$2b$10$hash");
    expect(config.dashboardSessionSecret).toBe("session-secret");
    expect(config.dashboardSessionTtlMs).toBe(123_456);
    expect(config.oauthJobTimeoutMs).toBe(654_321);
    expect(config.cliproxyBinaryPath).toBe("/opt/cliproxy");
    expect(config.cliproxyConfigPath).toBe("/opt/cliproxy/config.json");
  });
});
