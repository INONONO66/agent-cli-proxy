import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { handleAnthropicRequest } from "./adapter";
import type { RequestContext } from "../../server/requestContext";

const NON_STREAMING_RESPONSE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "Hello" }],
  model: "claude-sonnet-4-20250514",
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
};

const mockCtx: RequestContext = {
  id: "test-id",
  startedAt: Date.now(),
  provider: "anthropic",
  path: "/v1/messages",
  method: "POST",
};

type CapturedRequest = { url: string; headers: Record<string, string>; body: string };
let capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  capturedRequests = [];

  (globalThis.fetch as unknown) = async (input: RequestInfo | URL) => {
    let url: string;
    let headers: Record<string, string> = {};
    let body = "";

    if (input instanceof Request) {
      url = input.url;
      headers = Object.fromEntries(input.headers.entries());
      body = await input.text();
    } else {
      url = typeof input === "string" ? input : input.toString();
    }

    capturedRequests.push({ url, headers, body });

    return new Response(JSON.stringify(NON_STREAMING_RESPONSE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeRequest(body: unknown, extraHeaders?: Record<string, string>): Request {
  return new Request("http://localhost:3100/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

describe("handleAnthropicRequest", () => {
  it("non-streaming: returns response with content and calls onUsage", async () => {
    const usageCalls: unknown[] = [];
    const req = makeRequest({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    });

    const res = await handleAnthropicRequest(req, mockCtx, (u) => usageCalls.push(u));

    expect(res.status).toBe(200);
    const json = await res.json() as typeof NON_STREAMING_RESPONSE;
    expect(json.content[0]?.text).toBe("Hello");
    expect(usageCalls.length).toBe(1);
    expect(usageCalls[0]).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
      incomplete: false,
    });
  });

  it("tool prefix round-trip: mcp_Bash stripped to bash in response", async () => {
    (globalThis.fetch as unknown) = async (input: RequestInfo | URL) => {
      if (input instanceof Request) await input.text();
      return new Response(
        JSON.stringify({
          ...NON_STREAMING_RESPONSE,
          content: [{ type: "tool_use", name: "mcp_Bash", id: "tu_1", input: {} }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const req = makeRequest({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "run it" }],
      stream: false,
    });

    const res = await handleAnthropicRequest(req, mockCtx);
    const json = await res.json() as { content: Array<{ name: string }> };
    expect(json.content[0]?.name).toBe("bash");
  });

  it("streaming: returns SSE response", async () => {
    (globalThis.fetch as unknown) = async (input: RequestInfo | URL) => {
      if (input instanceof Request) await input.text();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n'
            )
          );
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n'
            )
          );
          controller.enqueue(new TextEncoder().encode('data: {"type":"message_stop"}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const req = makeRequest({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "stream this" }],
      stream: true,
    });

    const res = await handleAnthropicRequest(req, mockCtx, () => {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  it("invalid JSON body: returns 400", async () => {
    const req = new Request("http://localhost:3100/v1/messages", {
      method: "POST",
      body: "not-json",
      headers: { "content-type": "application/json" },
    });

    const res = await handleAnthropicRequest(req, mockCtx);
    expect(res.status).toBe(400);
    const json = await res.json() as { error: { type: string } };
    expect(json.error.type).toBe("invalid_request_error");
  });

  it("upstream error: passes through 403 status", async () => {
    (globalThis.fetch as unknown) = async (input: RequestInfo | URL) => {
      if (input instanceof Request) await input.text();
      return new Response(JSON.stringify({ error: { type: "permission_error" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    };

    const req = makeRequest({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    const res = await handleAnthropicRequest(req, mockCtx);
    expect(res.status).toBe(403);
  });

  it("transform pipeline: upstream receives mcp_-prefixed tools and Claude Code user-agent", async () => {
    const req = makeRequest({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "use a tool" }],
      tools: [{ name: "bash", description: "Run bash", input_schema: {} }],
      stream: false,
    });

    await handleAnthropicRequest(req, mockCtx);

    expect(capturedRequests.length).toBe(1);
    const captured = capturedRequests[0]!;

    expect(captured.url).toContain("/v1/messages");
    expect(captured.headers["user-agent"]).toMatch(/^claude-cli\//);

    const sentBody = JSON.parse(captured.body) as { tools: Array<{ name: string }> };
    expect(sentBody.tools[0]?.name).toBe("mcp_Bash");
  });
});
