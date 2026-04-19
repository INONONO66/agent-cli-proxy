import { describe, it, expect } from "bun:test";
import { relayStream } from "./relayStream";
import type { TokenUsage } from "../types/index";

function makeSSEResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

async function collectResponse(res: Response): Promise<string> {
  return await res.text();
}

describe("relayStream - passthrough mode (OpenAI)", () => {
  it("passes bytes through unchanged when no transformLine", async () => {
    const sseBody =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const upstream = makeSSEResponse(sseBody);
    let capturedUsage: TokenUsage | null = null;
    const relayed = relayStream(upstream, {
      provider: "openai",
      onUsage: (u) => {
        capturedUsage = u;
      },
    });
    const output = await collectResponse(relayed);
    expect(output).toBe(sseBody);
    expect(capturedUsage).not.toBeNull();
  });

  it("extracts usage from final OpenAI chunk", async () => {
    const usageChunk = JSON.stringify({
      choices: [{ finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const sseBody =
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: ${usageChunk}\n\ndata: [DONE]\n\n`;
    const upstream = makeSSEResponse(sseBody);
    const captured: TokenUsage[] = [];
    const relayed = relayStream(upstream, {
      provider: "openai",
      onUsage: (u) => captured.push(u),
    });
    await collectResponse(relayed);
    const usage = captured[0]!;
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
    expect(usage.total_tokens).toBe(15);
  });

  it("returns correct content-type header", async () => {
    const upstream = makeSSEResponse("data: test\n\n");
    const relayed = relayStream(upstream, {
      provider: "openai",
      onUsage: () => {},
    });
    expect(relayed.headers.get("content-type")).toBe("text/event-stream");
  });
});

describe("relayStream - transform mode (Anthropic)", () => {
  it("applies transformLine to data lines", async () => {
    const sseBody =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Bash"}}\n\n';
    const upstream = makeSSEResponse(sseBody);
    const relayed = relayStream(upstream, {
      provider: "anthropic",
      onUsage: () => {},
      transformLine: (line) => line.replace(/"mcp_Bash"/g, '"bash"'),
    });
    const output = await collectResponse(relayed);
    expect(output).toContain('"bash"');
    expect(output).not.toContain('"mcp_Bash"');
  });

  it("extracts Anthropic usage from stream", async () => {
    const startEvent = JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 100 } },
    });
    const deltaEvent = JSON.stringify({ type: "message_delta", usage: { output_tokens: 30 } });
    const sseBody = `data: ${startEvent}\n\ndata: ${deltaEvent}\n\ndata: {"type":"message_stop"}\n\n`;
    const upstream = makeSSEResponse(sseBody);
    const captured: TokenUsage[] = [];
    const relayed = relayStream(upstream, {
      provider: "anthropic",
      onUsage: (u) => captured.push(u),
    });
    await collectResponse(relayed);
    const usage = captured[0]!;
    expect(usage.prompt_tokens).toBe(100);
    expect(usage.completion_tokens).toBe(30);
    expect(usage.total_tokens).toBe(130);
    expect(usage.incomplete).toBe(false);
  });

  it("fires onUsage even with no usage events", async () => {
    const startEvent = JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 100 } },
    });
    const sseBody = `data: ${startEvent}\n\n`;
    const upstream = makeSSEResponse(sseBody);
    const captured: TokenUsage[] = [];
    const relayed = relayStream(upstream, {
      provider: "anthropic",
      onUsage: (u) => captured.push(u),
    });
    await collectResponse(relayed);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]!.prompt_tokens).toBe(100);
  });

  it("non-data SSE lines pass through unchanged in transform mode", async () => {
    const sseBody = "event: ping\n\ndata: {\"type\":\"message_stop\"}\n\n";
    const upstream = makeSSEResponse(sseBody);
    const relayed = relayStream(upstream, {
      provider: "anthropic",
      onUsage: () => {},
      transformLine: (line) => line,
    });
    const output = await collectResponse(relayed);
    expect(output).toContain("event: ping");
  });
});

describe("relayStream - null body", () => {
  it("fires onUsage with incomplete:true when body is null", () => {
    const upstream = new Response(null, { status: 200 });
    const captured: TokenUsage[] = [];
    relayStream(upstream, {
      provider: "anthropic",
      onUsage: (u) => captured.push(u),
    });
    expect(captured[0]!.incomplete).toBe(true);
  });
});
