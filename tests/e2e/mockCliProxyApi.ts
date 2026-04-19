export interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockCliProxyApi {
  server: ReturnType<typeof Bun.serve>;
  receivedRequests: MockRequest[];
  stop(): void;
}

export function startMockCliProxyApi(port: number): MockCliProxyApi {
  const receivedRequests: MockRequest[] = [];

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const bodyText = await req.text();
      let body: unknown = null;
      try {
        body = JSON.parse(bodyText);
      } catch {}

      receivedRequests.push({
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      });

      if (url.pathname === "/v1/messages") {
        const reqBody = body as Record<string, unknown>;
        const isStreaming = reqBody?.stream === true;

        if (isStreaming) {
          const stream = new ReadableStream({
            start(controller) {
              const events = [
                `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_mock", model: "claude-sonnet-4-20250514", role: "assistant", content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n\n`,
                `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
                `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello!" } })}\n\n`,
                `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
                `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
                `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
              ];
              for (const event of events) {
                controller.enqueue(new TextEncoder().encode(event));
              }
              controller.close();
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "close",
            },
          });
        }

        return new Response(
          JSON.stringify({
            id: "msg_mock",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello from mock!" }],
            model: "claude-sonnet-4-20250514",
            stop_reason: "end_turn",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          }),
          { headers: { "content-type": "application/json", connection: "close" } },
        );
      }

      if (url.pathname === "/v1/chat/completions") {
        const reqBody = body as Record<string, unknown>;
        const isStreaming = reqBody?.stream === true;

        if (isStreaming) {
          const stream = new ReadableStream({
            start(controller) {
              const events = [
                `data: ${JSON.stringify({ id: "chatcmpl_mock", choices: [{ delta: { role: "assistant", content: "" }, index: 0 }] })}\n\n`,
                `data: ${JSON.stringify({ id: "chatcmpl_mock", choices: [{ delta: { content: "Hello!" }, index: 0 }] })}\n\n`,
                `data: ${JSON.stringify({ id: "chatcmpl_mock", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
                `data: [DONE]\n\n`,
              ];
              for (const event of events) {
                controller.enqueue(new TextEncoder().encode(event));
              }
              controller.close();
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "close",
            },
          });
        }

        return new Response(
          JSON.stringify({
            id: "chatcmpl_mock",
            object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "Hello from mock!" }, finish_reason: "stop", index: 0 }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { headers: { "content-type": "application/json", connection: "close" } },
        );
      }

      return new Response("Not Found", { status: 404, headers: { connection: "close" } });
    },
  });

  return {
    server,
    receivedRequests,
    stop() {
      server.stop(true);
    },
  };
}
