import type { TokenUsage } from "../types/index";
import {
  parseAnthropicSSELine,
  accumulateUsage,
  finalizeUsage,
} from "../providers/anthropic/parseStreamUsage";
import { parseOpenAISSELine, finalizeOpenAIUsage } from "../providers/openai/parseStreamUsage";

export interface RelayOptions {
  onUsage: (usage: TokenUsage) => void;
  transformLine?: (line: string) => string;
  provider: "anthropic" | "openai";
}

export function relayStream(upstreamResponse: Response, options: RelayOptions): Response {
  const { onUsage, transformLine, provider } = options;

  let partialLine = "";
  let anthropicAcc: Partial<TokenUsage> = {};
  let openaiUsage: Partial<TokenUsage> | null = null;
  let streamEnded = false;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  function processLine(dataContent: string): string {
    if (provider === "anthropic") {
      const partial = parseAnthropicSSELine(dataContent);
      if (partial) anthropicAcc = accumulateUsage(anthropicAcc, partial);
    } else {
      const partial = parseOpenAISSELine(dataContent);
      if (partial) openaiUsage = partial;
    }

    return transformLine ? transformLine(dataContent) : dataContent;
  }

  function processChunkText(text: string): string {
    const combined = partialLine + text;
    const lines = combined.split("\n");
    partialLine = lines.pop() ?? "";

    let output = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const dataContent = line.slice(6);
        const transformed = processLine(dataContent);
        output += transformLine ? `data: ${transformed}\n` : `${line}\n`;
      } else {
        output += `${line}\n`;
      }
    }
    return output;
  }

  function fireUsage(incomplete: boolean): void {
    const usage =
      provider === "anthropic"
        ? finalizeUsage(anthropicAcc, incomplete)
        : finalizeOpenAIUsage(openaiUsage, incomplete);
    onUsage(usage);
  }

  const upstreamBody = upstreamResponse.body;
  if (!upstreamBody) {
    fireUsage(true);
    return new Response(null, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    });
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const processed = processChunkText(text);
      controller.enqueue(encoder.encode(processed));
    },
    flush(controller) {
      if (partialLine) {
        const processed = processChunkText(`${partialLine}\n`);
        if (processed) controller.enqueue(encoder.encode(processed));
        partialLine = "";
      }
      streamEnded = true;
      fireUsage(false);
    },
  });

  const outputStream = upstreamBody.pipeThrough(transform).pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush() {
        if (!streamEnded) {
          fireUsage(true);
        }
      },
    }),
  );

  const headers = new Headers(upstreamResponse.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");

  return new Response(outputStream, {
    status: upstreamResponse.status,
    headers,
  });
}
