import { expect, test } from "bun:test";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";

import type { RequestInfo } from "../../../src/agent-plugins";
import { Anthropic } from "../../../src/provider/anthropic";
import { rewriteRequestBody } from "../../../src/provider/anthropic/transform";

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

test("opencode matches opencode user-agent", async () => {
  const { opencodePlugin } = await import("../../../src/agent-plugins/opencode");
  expect(opencodePlugin.matches(makeRequestInfo({ userAgent: "opencode/1.0.0" }))).toBe(true);
});

test("opencode does not match non-opencode user-agent", async () => {
  const { opencodePlugin } = await import("../../../src/agent-plugins/opencode");
  expect(opencodePlugin.matches(makeRequestInfo({ userAgent: "curl/8.0" }))).toBe(false);
});

test("opencode injects Claude Code headers for messages path", async () => {
  const { opencodePlugin } = await import("../../../src/agent-plugins/opencode");

  const headers = new Headers({ "x-custom": "keep" });
  const result = opencodePlugin.transformHeaders(headers, makeRequestInfo());
  const expected = Anthropic.buildClaudeCodeHeaders();

  expect(result).not.toBe(headers);
  expect(result.get("x-custom")).toBe("keep");
  for (const [key, value] of Object.entries(expected)) {
    expect(result.get(key)).toBe(value);
  }
});

test("opencode leaves headers unchanged outside messages path", async () => {
  const { opencodePlugin } = await import("../../../src/agent-plugins/opencode");
  const headers = new Headers({ "x-custom": "keep" });
  const result = opencodePlugin.transformHeaders(headers, makeRequestInfo({ path: "/v1/other" }));

  expect(result).toBe(headers);
  expect(result.get("x-custom")).toBe("keep");
});

test("opencode rewrites body for messages path", async () => {
  const { opencodePlugin } = await import("../../../src/agent-plugins/opencode");

  const body = {
    model: "claude-3-5-sonnet-latest",
    system: [{ type: "text" as const, text: "You are OpenCode.\n\nStay focused." }],
    messages: [{ role: "user" as const, content: "hello" }],
    tools: [
      {
        name: "readFile",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  };

  expect(opencodePlugin.transformBody?.(body, makeRequestInfo())).toEqual(rewriteRequestBody(body));
});

test("opencode strips tool prefix from stream lines", async () => {
  const { opencodePlugin } = await import("../../../src/agent-plugins/opencode");
  expect(opencodePlugin.transformStreamLine?.('data: {"name": "mcp_readFile"}', makeRequestInfo())).toBe(
    'data: {"name": "readFile"}',
  );
});
