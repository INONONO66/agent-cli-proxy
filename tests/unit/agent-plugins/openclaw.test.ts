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

test("openclaw matches openclaw originator", async () => {
  const { openclawPlugin } = await import("../../../src/agent-plugins/openclaw");
  expect(openclawPlugin.matches(makeRequestInfo({ originator: "openclaw" }))).toBe(true);
});

test("openclaw matches openclaw user-agent", async () => {
  const { openclawPlugin } = await import("../../../src/agent-plugins/openclaw");
  expect(openclawPlugin.matches(makeRequestInfo({ userAgent: "openclaw-agent/1.0" }))).toBe(true);
});

test("openclaw does not match unrelated request", async () => {
  const { openclawPlugin } = await import("../../../src/agent-plugins/openclaw");
  expect(openclawPlugin.matches(makeRequestInfo({ userAgent: "curl/8.0" }))).toBe(false);
});

test("openclaw uses the same message headers as opencode", async () => {
  const [{ openclawPlugin }, { opencodePlugin }] = await Promise.all([
    import("../../../src/agent-plugins/openclaw"),
    import("../../../src/agent-plugins/opencode"),
  ]);

  const headers = new Headers({ "x-custom": "keep" });
  const info = makeRequestInfo();
  const openclawHeaders = openclawPlugin.transformHeaders(headers, info);
  const opencodeHeaders = opencodePlugin.transformHeaders(headers, info);

  expect(Object.fromEntries(openclawHeaders.entries())).toEqual(
    Object.fromEntries(opencodeHeaders.entries()),
  );
});
