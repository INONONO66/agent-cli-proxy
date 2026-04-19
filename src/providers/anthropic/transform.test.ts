import { describe, expect, test } from "bun:test";
import {
  buildBillingHeaderValue,
  computeCCH,
  computeVersionSuffix,
} from "./cch";
import {
  prefixToolNames,
  prependClaudeCodeIdentity,
  rewriteRequestBody,
  sanitizeSystemText,
  stripToolPrefix,
  stripToolPrefixFromLine,
} from "./transform";
import type { AnthropicRequest, AnthropicResponse, SystemBlock } from "../../types/anthropic";

const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

describe("prefixToolNames", () => {
  test("bash → mcp_Bash", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [],
      tools: [{ name: "bash" }],
    };
    const result = prefixToolNames(req);
    expect(result.tools![0]!.name).toBe("mcp_Bash");
  });

  test("read → mcp_Read, write → mcp_Write", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [],
      tools: [{ name: "read" }, { name: "write" }],
    };
    const result = prefixToolNames(req);
    expect(result.tools![0]!.name).toBe("mcp_Read");
    expect(result.tools![1]!.name).toBe("mcp_Write");
  });

  test("empty tools array stays unchanged", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [],
      tools: [],
    };
    const result = prefixToolNames(req);
    expect(result.tools).toEqual([]);
  });

  test("prefixes tool_use blocks in messages", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "bash", id: "1" },
            { type: "text", text: "done" },
          ],
        },
      ],
    };
    const result = prefixToolNames(req);
    const content = result.messages[0]!.content as Array<{ type: string; name?: string }>;
    expect(content[0]!.name).toBe("mcp_Bash");
    expect(content[1]!.type).toBe("text");
  });
});

describe("stripToolPrefix", () => {
  test("mcp_Bash → bash in response content", () => {
    const resp: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", name: "mcp_Bash", id: "1" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = stripToolPrefix(resp);
    expect(result.content[0]!.name).toBe("bash");
  });

  test("non-prefixed names unchanged", () => {
    const resp: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", name: "regular_tool", id: "1" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = stripToolPrefix(resp);
    expect(result.content[0]!.name).toBe("regular_tool");
  });
});

describe("sanitizeSystemText", () => {
  test("removes paragraph containing github.com/anomalyco/opencode", () => {
    const blocks: SystemBlock[] = [
      { type: "text", text: "You are OpenCode, the best coding agent on the planet.\n\nReport issues at https://github.com/anomalyco/opencode please.\n\nOther content." },
    ];
    const result = sanitizeSystemText(blocks);
    expect(result[0]!.text).not.toContain("github.com/anomalyco/opencode");
    expect(result[0]!.text).toContain("Other content.");
  });

  test("removes paragraph containing opencode.ai/docs", () => {
    const blocks: SystemBlock[] = [
      { type: "text", text: "You are OpenCode, the best coding agent on the planet.\n\nCheck out https://opencode.ai/docs for more.\n\nGeneric instructions." },
    ];
    const result = sanitizeSystemText(blocks);
    expect(result[0]!.text).not.toContain("opencode.ai/docs");
    expect(result[0]!.text).toContain("Generic instructions.");
  });

  test("replaces 'if OpenCode honestly' → 'if the assistant honestly'", () => {
    const blocks: SystemBlock[] = [
      { type: "text", text: "You are OpenCode, the best coding agent on the planet.\n\nIt is best if OpenCode honestly applies rigorous standards." },
    ];
    const result = sanitizeSystemText(blocks);
    expect(result[0]!.text).toContain("if the assistant honestly");
    expect(result[0]!.text).not.toContain("if OpenCode honestly");
  });

  test("preserves unrelated text", () => {
    const blocks: SystemBlock[] = [
      { type: "text", text: "Just a normal system prompt with no OpenCode identity." },
    ];
    const result = sanitizeSystemText(blocks);
    expect(result[0]!.text).toBe("Just a normal system prompt with no OpenCode identity.");
  });
});

describe("prependClaudeCodeIdentity", () => {
  test("adds identity block at index 0", () => {
    const blocks: SystemBlock[] = [{ type: "text", text: "Some instructions." }];
    const result = prependClaudeCodeIdentity(blocks, "");
    expect(result[0]!.text).toBe(CLAUDE_CODE_IDENTITY);
    expect(result[1]!.text).toBe("Some instructions.");
  });

  test("billing header prepended to identity text", () => {
    const blocks: SystemBlock[] = [];
    const result = prependClaudeCodeIdentity(blocks, "x-anthropic-billing-header: cc_version=2.1.87.abc;");
    expect(result[0]!.text).toContain("x-anthropic-billing-header");
    expect(result[0]!.text).toContain(CLAUDE_CODE_IDENTITY);
  });
});

describe("rewriteRequestBody", () => {
  test("moves non-identity system blocks to first user message", () => {
    const req: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "hello" }],
      system: [{ type: "text", text: "Custom instructions." }],
    };
    const result = rewriteRequestBody(req);
    const system = result.system as SystemBlock[];
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toContain(CLAUDE_CODE_IDENTITY);
    expect(result.messages[0]!.content).toContain("Custom instructions.");
  });
});

describe("computeCCH", () => {
  test("deterministic: same input → same output", () => {
    expect(computeCCH("hello world test message")).toBe(computeCCH("hello world test message"));
  });

  test("different inputs → different outputs", () => {
    expect(computeCCH("hello")).not.toBe(computeCCH("world"));
  });

  test("known test vector: 'hello world test message' → '4ffc3'", () => {
    expect(computeCCH("hello world test message")).toBe("4ffc3");
  });

  test("known test vector: version suffix for 'hello world test message' → '6ff'", () => {
    expect(computeVersionSuffix("hello world test message", "2.1.87")).toBe("6ff");
  });
});

describe("buildBillingHeaderValue", () => {
  test("returns string containing 'cc_version='", () => {
    const messages = [{ role: "user" as const, content: "hello world test message" }];
    const result = buildBillingHeaderValue(messages, "sdk-cli");
    expect(result).toContain("cc_version=");
  });

  test("known test vector matches original", () => {
    const messages = [{ role: "user" as const, content: "hello world test message" }];
    const result = buildBillingHeaderValue(messages, "sdk-cli", "2.1.87");
    expect(result).toBe(
      "x-anthropic-billing-header: cc_version=2.1.87.6ff; cc_entrypoint=sdk-cli; cch=4ffc3;",
    );
  });
});

describe("stripToolPrefixFromLine", () => {
  test("strips mcp_ from tool_use name in SSE JSON line", () => {
    const line = 'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Bash"}}';
    expect(stripToolPrefixFromLine(line)).toContain('"name": "bash"');
  });

  test("leaves non-prefixed names unchanged", () => {
    const line = '{"name": "regular_tool"}';
    expect(stripToolPrefixFromLine(line)).toBe(line);
  });
});
