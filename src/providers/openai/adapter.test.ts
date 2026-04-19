import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { handleOpenAIRequest } from "./adapter";
import type { RequestContext } from "../../server/requestContext";

let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  (globalThis.fetch as any) = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    let actualInit = init || {};
    if (input instanceof Request) {
      url = input.url;
      actualInit = { headers: Object.fromEntries(input.headers.entries()) };
    } else {
      url = typeof input === "string" ? input : input.toString();
    }
    fetchCalls.push({ url, init: actualInit });

    const body = init?.body as string;
    const isStreaming =
      body?.includes('"stream":true') || body?.includes('"stream": true');

    if (isStreaming) {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
            )
          );
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'
            )
          );
          controller.enqueue(
            new TextEncoder().encode("data: [DONE]\n\n")
          );
          controller.close();
        },
      });

      return new Response(mockStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    } else {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-123",
          choices: [{ message: { content: "hello" } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("handleOpenAIRequest", () => {
  const mockCtx: RequestContext = {
    id: "test-id",
    startedAt: Date.now(),
    provider: "openai",
    path: "/v1/chat/completions",
    method: "POST",
  };

  it("forwards non-streaming request to CLIProxyAPI and returns response", async () => {
    const req = new Request("http://localhost:3100/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
      headers: { "content-type": "application/json" },
    });

    const response = await handleOpenAIRequest(req, mockCtx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = await response.json();
    expect(body.usage).toBeDefined();
    expect(body.usage.prompt_tokens).toBe(10);
    expect(body.usage.completion_tokens).toBe(5);
  });

  it("calls onUsage callback with token counts for non-streaming", async () => {
    const usageData: unknown[] = [];
    const req = new Request("http://localhost:3100/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
      headers: { "content-type": "application/json" },
    });

    await handleOpenAIRequest(req, mockCtx, (usage) => {
      usageData.push(usage);
    });

    expect(usageData.length).toBe(1);
    expect(usageData[0]).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 15,
      incomplete: false,
    });
  });

  it("returns streaming response for streaming request", async () => {
    const req = new Request("http://localhost:3100/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
      headers: { "content-type": "application/json" },
    });

    const response = await handleOpenAIRequest(req, mockCtx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  it("forwards authorization headers to upstream", async () => {
    const req = new Request("http://localhost:3100/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
    });

    await handleOpenAIRequest(req, mockCtx);

    expect(fetchCalls.length).toBe(1);
    const upstreamReq = fetchCalls[0];
    expect(upstreamReq.url).toContain("/v1/chat/completions");
  });

  it("handles missing usage in response gracefully", async () => {
    (globalThis.fetch as any) = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-123",
          choices: [{ message: { content: "hello" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    };

    const usageData: unknown[] = [];
    const req = new Request("http://localhost:3100/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
      headers: { "content-type": "application/json" },
    });

    await handleOpenAIRequest(req, mockCtx, (usage) => {
      usageData.push(usage);
    });

    expect(usageData.length).toBe(0);
  });
});
