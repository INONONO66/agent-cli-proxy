import { test, expect } from "bun:test";
import { RelayStream } from "../../src/server/relay-stream";

const MAX_SSE_LINE_BYTES = 1_048_576;

function createStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = "";
  return (async function read(): Promise<string> {
    const { done, value } = await reader.read();
    if (done) return result;
    result += decoder.decode(value, { stream: true });
    return read();
  })();
}

test("RelayStream truncates oversized partial line and continues streaming", async () => {
  const oversizedChunk = "x".repeat(MAX_SSE_LINE_BYTES * 2);
  const validChunk = "data: hello\n\n";

  const upstream = new Response(createStream([oversizedChunk, validChunk]));
  const relayed = RelayStream.relay(upstream, {
    provider: "openai",
    onUsage: () => {},
  });

  const output = await readAll(relayed);
  expect(output).toContain("data: hello");
});

test("RelayStream handles normal chunks without truncation", async () => {
  const chunk1 = "data: first\n";
  const chunk2 = "data: second\n\n";

  const upstream = new Response(createStream([chunk1, chunk2]));
  const relayed = RelayStream.relay(upstream, {
    provider: "openai",
    onUsage: () => {},
  });

  const output = await readAll(relayed);
  expect(output).toContain("data: first");
  expect(output).toContain("data: second");
});

test("RelayStream truncates exactly at boundary and continues", async () => {
  const oversizedChunk = "a".repeat(MAX_SSE_LINE_BYTES + 1);
  const validChunk = "data: after\n\n";

  const upstream = new Response(createStream([oversizedChunk, validChunk]));
  const relayed = RelayStream.relay(upstream, {
    provider: "openai",
    onUsage: () => {},
  });

  const output = await readAll(relayed);
  expect(output).toContain("data: after");
});
