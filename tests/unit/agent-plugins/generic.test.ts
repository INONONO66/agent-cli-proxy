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

test("generic matches every request", async () => {
  const { genericPlugin } = await import("../../../src/agent-plugins/generic");
  expect(genericPlugin.matches(makeRequestInfo({ userAgent: "curl/8.0" }))).toBe(true);
});

test("generic injects Claude Code headers for messages path", async () => {
  const [{ genericPlugin }, { Anthropic }] = await Promise.all([
    import("../../../src/agent-plugins/generic"),
    import("../../../src/provider/anthropic"),
  ]);

  const headers = new Headers({ "x-custom": "keep" });
  const result = genericPlugin.transformHeaders(headers, makeRequestInfo());
  const expected = Anthropic.buildClaudeCodeHeaders();

  expect(result).not.toBe(headers);
  expect(result.get("x-custom")).toBe("keep");
  for (const [key, value] of Object.entries(expected)) {
    expect(result.get(key)).toBe(value);
  }
});

test("generic leaves headers unchanged outside messages path", async () => {
  const { genericPlugin } = await import("../../../src/agent-plugins/generic");
  const headers = new Headers({ "x-custom": "keep" });
  const result = genericPlugin.transformHeaders(headers, makeRequestInfo({ path: "/v1/other" }));

  expect(result).toBe(headers);
  expect(result.get("x-custom")).toBe("keep");
});
