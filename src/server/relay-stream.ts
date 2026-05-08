import type { TokenUsage } from "../usage";
import { parseAnthropicSSELine, accumulateUsage, finalizeUsage } from "../provider/anthropic/stream-usage";
import { parseOpenAISSELine, finalizeOpenAIUsage } from "../provider/openai/stream-usage";
import type { Anthropic } from "../provider/anthropic";
import type { OpenAI } from "../provider/openai/stream-usage";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "relay-stream" });
const MAX_SSE_LINE_BYTES = 1_048_576;

export namespace RelayStream {
  export interface Options {
    onUsage: (usage: TokenUsage) => void;
    transformLine?: (line: string) => string;
    provider: "anthropic" | "openai";
  }

  export function relay(upstreamResponse: Response, options: Options): Response {
    const { onUsage, transformLine, provider } = options;

    let partialLine = "";
    let anthropicAcc: Partial<Anthropic.TokenUsage> = {};
    let openaiUsage: Partial<OpenAI.TokenUsage> | null = null;
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
      if (partialLine.length > MAX_SSE_LINE_BYTES) {
        logger.warn("SSE partial line exceeds max size, truncating", { event: "relay.sse_line_too_long", length: partialLine.length });
        partialLine = "";
      }

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

    const transformedStream = upstreamBody.pipeThrough(transform);

    const outputStream = new ReadableStream({
      async start(controller) {
        const reader = transformedStream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          if (!streamEnded) {
            fireUsage(true);
            streamEnded = true;
          }
          controller.error(err);
          return;
        }
      },
      cancel() {
        if (!streamEnded) {
          fireUsage(true);
          streamEnded = true;
        }
      },
    });

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
}
