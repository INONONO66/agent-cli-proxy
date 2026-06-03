import { expect, test } from "bun:test";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";

async function loadModules() {
  const [config, anthropic, transform] = await Promise.all([
    import("../../src/config"),
    import("../../src/provider/anthropic"),
    import("../../src/provider/anthropic/transform"),
  ]);

  return {
    toolPrefix: config.Config.toolPrefix,
    buildClaudeCodeHeaders: anthropic.Anthropic.buildClaudeCodeHeaders,
    rewriteRequestBody: transform.rewriteRequestBody,
    stripToolPrefix: transform.stripToolPrefix,
    stripToolPrefixFromLine: transform.stripToolPrefixFromLine,
  };
}

test("buildClaudeCodeHeaders returns the current bypass header set", async () => {
  const { buildClaudeCodeHeaders } = await loadModules();
  const headers = buildClaudeCodeHeaders();

  expect(Object.keys(headers).sort()).toEqual([
    "anthropic-beta",
    "anthropic-dangerous-direct-browser-access",
    "user-agent",
    "x-app",
    "x-claude-code-session-id",
    "x-stainless-arch",
    "x-stainless-lang",
    "x-stainless-os",
    "x-stainless-runtime",
    "x-stainless-runtime-version",
  ].sort());

  expect(headers["user-agent"]).toContain("claude-cli/");
  expect(headers["x-app"]).toBe("cli");
  expect(headers["x-claude-code-session-id"]).toMatch(/\S+/);
  expect(["arm64", "x64"]).toContain(headers["x-stainless-arch"]);
  expect(["macOS", "Linux", "Windows"]).toContain(headers["x-stainless-os"]);
  expect(headers["x-stainless-lang"]).toBe("js");
  expect(headers["x-stainless-runtime"]).toBe("node");
  expect(headers["x-stainless-runtime-version"]).toMatch(/\S+/);
  expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
  expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
});

test("rewriteRequestBody rewrites system text, tool names, and user message content", async () => {
  const { toolPrefix, rewriteRequestBody } = await loadModules();

  const body = {
    model: "claude-3-5-sonnet-latest",
    system: [
      { type: "text" as const, text: "You are OpenCode.\n\nStay focused." },
    ],
    messages: [
      { role: "user" as const, content: "hello" },
    ],
    tools: [
      {
        name: "readFile",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  };

  const rewritten = rewriteRequestBody(body);

  expect(rewritten.system).toEqual([
    {
      type: "text",
      text: "x-anthropic-billing-header: cc_version=2.1.87.16a; cc_entrypoint=sdk-cli; cch=2cf24;",
    },
    {
      type: "text",
      text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    },
  ]);
  expect(rewritten.messages).toEqual([
    {
      role: "user",
      content: "Stay focused.\n\nhello",
    },
  ]);
  expect(rewritten.tools).toEqual([
    {
      name: `${toolPrefix}ReadFile`,
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
  ]);
});

test("rewriteRequestBody removes Anthropic provider namespace from model", async () => {
  const { rewriteRequestBody } = await loadModules();

  const rewritten = rewriteRequestBody({
    model: "anthropic/claude-sonnet-4-6",
    messages: [
      { role: "user", content: "hello" },
    ],
    max_tokens: 8,
  });

  expect(rewritten.model).toBe("claude-sonnet-4-6");
});

test("rewriteRequestBody strips context_management so CLIProxyAPI does not 400", async () => {
  const { rewriteRequestBody } = await loadModules();

  const rewritten = rewriteRequestBody({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 8,
    context_management: { type: "auto" },
  });

  expect(rewritten).not.toHaveProperty("context_management");
  expect(rewritten.model).toBe("claude-sonnet-4-5");
  expect(rewritten.messages).toEqual([{ role: "user", content: "hello" }]);
});

test("stripToolPrefix removes the tool prefix from response blocks", async () => {
  const { stripToolPrefix, toolPrefix } = await loadModules();

  const response = {
    id: "msg_01",
    type: "message" as const,
    role: "assistant" as const,
    content: [
      { type: "tool_use" as const, id: "tool_01", name: `${toolPrefix}ReadFile`, input: { path: "README.md" } },
      { type: "text" as const, text: "done" },
    ],
    model: "claude-3-5-sonnet-latest",
    stop_reason: "tool_use",
    usage: {
      input_tokens: 1,
      output_tokens: 2,
    },
  };

  expect(stripToolPrefix(response)).toEqual({
    ...response,
    content: [
      { type: "tool_use", id: "tool_01", name: "readFile", input: { path: "README.md" } },
      { type: "text", text: "done" },
    ],
  });
});

test("stripToolPrefixFromLine removes the prefix in SSE payload lines", async () => {
  const { stripToolPrefixFromLine } = await loadModules();

  const line = 'data: {"name": "mcp_readFile"}';

  expect(stripToolPrefixFromLine(line)).toBe('data: {"name": "readFile"}');
});
