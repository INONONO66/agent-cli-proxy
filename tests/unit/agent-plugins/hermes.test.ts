import { expect, test } from "bun:test";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";

import type { RequestInfo } from "../../../src/agent-plugins";

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

test("hermes matches HermesAgent user-agent", async () => {
  const { hermesPlugin } = await import("../../../src/agent-plugins/hermes");
  expect(hermesPlugin.matches(makeRequestInfo({ userAgent: "HermesAgent/1.0" }))).toBe(true);
});

test("hermes does not match non-hermes user-agent", async () => {
  const { hermesPlugin } = await import("../../../src/agent-plugins/hermes");
  expect(hermesPlugin.matches(makeRequestInfo({ userAgent: "curl/8.0" }))).toBe(false);
});
