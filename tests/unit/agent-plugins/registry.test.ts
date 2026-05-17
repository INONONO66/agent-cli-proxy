import { expect, test } from "bun:test";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";

function makeRequestInfo(overrides: Partial<RequestInfo> = {}): RequestInfo {
  return {
    model: null,
    agentName: null,
    userAgent: null,
    originator: null,
    sessionId: null,
    apiKey: null,
    isStreaming: false,
    path: "/v1/messages",
    method: "POST",
    clientIp: null,
    ...overrides,
  };
}

import type { RequestInfo } from "../../../src/agent-plugins";

test("AgentPlugins resolves opencode plugin for opencode user-agent", async () => {
  const { AgentPlugins } = await import("../../../src/agent-plugins");
  const info = makeRequestInfo({ userAgent: "opencode/1.0.0" });
  const plugin = AgentPlugins.resolve(info);
  expect(plugin.id).toBe("opencode");
});

test("AgentPlugins resolves openclaw plugin for openclaw originator", async () => {
  const { AgentPlugins } = await import("../../../src/agent-plugins");
  const info = makeRequestInfo({ originator: "openclaw" });
  const plugin = AgentPlugins.resolve(info);
  expect(plugin.id).toBe("openclaw");
});

test("AgentPlugins resolves hermes plugin for HermesAgent user-agent", async () => {
  const { AgentPlugins } = await import("../../../src/agent-plugins");
  const info = makeRequestInfo({ userAgent: "HermesAgent/1.0" });
  const plugin = AgentPlugins.resolve(info);
  expect(plugin.id).toBe("hermes");
});

test("AgentPlugins resolves generic plugin for unknown request", async () => {
  const { AgentPlugins } = await import("../../../src/agent-plugins");
  const info = makeRequestInfo({ userAgent: "curl/7.0" });
  const plugin = AgentPlugins.resolve(info);
  expect(plugin.id).toBe("generic");
});

test("AgentPlugins keeps first registered match", async () => {
  const { AgentPlugins } = await import("../../../src/agent-plugins");

  AgentPlugins.register({
    id: "late-opencode",
    matches(info) {
      return info.userAgent === "opencode/1.0.0";
    },
    transformHeaders(headers) {
      return headers;
    },
  });

  const plugin = AgentPlugins.resolve(makeRequestInfo({ userAgent: "opencode/1.0.0" }));
  expect(plugin.id).toBe("opencode");
});
