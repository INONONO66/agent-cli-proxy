import { Config } from "../config";
import { RequestInspector, type RequestInfo } from "./request-inspector";
import { ResponseParser } from "./response-parser";
import { UsageService } from "../storage/service";
import { Anthropic } from "../provider/anthropic";
import { rewriteRequestBody, stripToolPrefix, stripToolPrefixFromLine } from "../provider/anthropic/transform";
import { UpstreamClient } from "../upstream/client";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "pass-through" });

export namespace PassThroughProxy {
  export function create(usageService: UsageService.UsageService) {
    return async function handle(req: Request, info: RequestInfo): Promise<Response> {
      const upstreamUrl = `${Config.cliProxyApiUrl}${info.path}`;
      const startTime = Date.now();
      const body = await buildBody(req, info);

      let upstreamResponse: Response;
      try {
        upstreamResponse = await UpstreamClient.fetch({
          method: req.method,
          url: upstreamUrl,
          headers: buildHeaders(req.headers, info),
          body,
          providerId: info.path.includes("messages") ? "anthropic" : "openai",
          idempotent: isIdempotentMethod(req.method),
        });
      } catch (err) {
        logger.error("upstream fetch failed", { err, path: info.path });
        return new Response(
          JSON.stringify({ error: "Upstream unavailable" }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }

      const isStreaming = upstreamResponse.headers
        .get("content-type")
        ?.includes("text/event-stream") ?? false;

      if (isStreaming) {
        return handleStreaming(upstreamResponse, info, usageService, startTime);
      }

      return handleNonStreaming(upstreamResponse, info, usageService, startTime);
    };
  }

  async function buildBody(req: Request, info: RequestInfo): Promise<BodyInit | null> {
    if (!info.path.includes("messages")) return req.body;
    const text = await req.text();
    try {
      const rewritten = rewriteRequestBody(JSON.parse(text) as Anthropic.Request);
      return JSON.stringify(rewritten);
    } catch (err) {
      logger.warn("anthropic rewrite failed, forwarding original body", { err, path: info.path });
      return text;
    }
  }

  function buildHeaders(headers: Headers, info: RequestInfo): Headers {
    const result = new Headers(headers);
    result.set("authorization", `Bearer ${Config.cliProxyApiKey}`);
    if (info.path.includes("messages")) {
      for (const [key, value] of Object.entries(Anthropic.buildClaudeCodeHeaders())) {
        result.set(key, value);
      }
    }
    result.delete("host");
    return result;
  }

  function isIdempotentMethod(method: string): boolean {
    return method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "DELETE" || method === "PUT";
  }

  async function handleNonStreaming(
    upstreamResponse: Response,
    info: RequestInfo,
    usageService: UsageService.UsageService,
    startTime: number,
  ): Promise<Response> {
    let responseText = await upstreamResponse.text();
    if (info.path.includes("messages")) {
      try {
        responseText = JSON.stringify(stripToolPrefix(JSON.parse(responseText) as Anthropic.Response));
      } catch (err) {
        logger.warn("anthropic response transform failed", { err, path: info.path, status: upstreamResponse.status });
      }
    }

    const parsed = ResponseParser.parseResponseBody(responseText);
    await logUsage(usageService, info, parsed, upstreamResponse.status, false, startTime);

    return new Response(responseText, {
      status: upstreamResponse.status,
      headers: {
        "content-type": "application/json",
      },
    });
  }

  function handleStreaming(
    upstreamResponse: Response,
    info: RequestInfo,
    usageService: UsageService.UsageService,
    startTime: number,
  ): Response {
    const upstreamBody = upstreamResponse.body;
    if (!upstreamBody) {
      return new Response(null, { status: upstreamResponse.status });
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let partialLine = "";
    let accumulated: ReturnType<typeof ResponseParser.parseSSELine>["usage"] = null;
    let actualModel: string | null = null;

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        const combined = partialLine + text;
        const lines = combined.split("\n");
        partialLine = lines.pop() ?? "";

        let output = "";
        for (const line of lines) {
          output += `${info.path.includes("messages") ? stripToolPrefixFromLine(line) : line}\n`;
          if (line.startsWith("data: ")) {
            const dataContent = line.slice(6);
            const parsed = ResponseParser.parseSSELine(dataContent);
            if (parsed.actualModel) actualModel = parsed.actualModel;
            if (parsed.usage) accumulated = mergeUsage(accumulated, parsed.usage);
          }
        }
        controller.enqueue(encoder.encode(output));
      },
      flush(controller) {
        if (partialLine) {
          const line = partialLine;
          if (line.startsWith("data: ")) {
            const dataContent = line.slice(6);
            const parsed = ResponseParser.parseSSELine(dataContent);
            if (parsed.actualModel) actualModel = parsed.actualModel;
            if (parsed.usage) accumulated = mergeUsage(accumulated, parsed.usage);
          }
        }
        logUsage(
          usageService,
          info,
          { actualModel, usage: accumulated },
          upstreamResponse.status,
          true,
          startTime,
        );
        controller.terminate();
      },
    });

    const transformedStream = upstreamBody.pipeThrough(transform);

    return new Response(transformedStream, {
      status: upstreamResponse.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  }

  function mergeUsage(
    acc: ReturnType<typeof ResponseParser.parseSSELine>["usage"],
    partial: NonNullable<ReturnType<typeof ResponseParser.parseSSELine>["usage"]>,
  ): NonNullable<ReturnType<typeof ResponseParser.parseSSELine>["usage"]> {
    if (!acc) return partial;
    return {
      prompt_tokens: acc.prompt_tokens + partial.prompt_tokens,
      completion_tokens: acc.completion_tokens + partial.completion_tokens,
      total_tokens: acc.total_tokens + partial.total_tokens,
      cache_creation_tokens: acc.cache_creation_tokens + partial.cache_creation_tokens,
      cache_read_tokens: acc.cache_read_tokens + partial.cache_read_tokens,
      reasoning_tokens: acc.reasoning_tokens + partial.reasoning_tokens,
    };
  }

  async function logUsage(
    usageService: UsageService.UsageService,
    info: RequestInfo,
    parsed: { actualModel: string | null; usage: ReturnType<typeof ResponseParser.parseSSELine>["usage"] },
    status: number,
    isStreaming: boolean,
    startTime: number,
  ): Promise<void> {
    const tool = RequestInspector.detectTool(info);
    const clientId = RequestInspector.generateClientId(tool, info);

    await usageService.recordUsage({
      provider: info.path.includes("messages") ? "anthropic" : "openai",
      model: parsed.actualModel ?? info.model ?? "unknown",
      actual_model: parsed.actualModel ?? undefined,
      tool,
      client_id: clientId,
      path: info.path,
      streamed: isStreaming ? 1 : 0,
      status,
      prompt_tokens: parsed.usage?.prompt_tokens ?? 0,
      completion_tokens: parsed.usage?.completion_tokens ?? 0,
      cache_creation_tokens: parsed.usage?.cache_creation_tokens ?? 0,
      cache_read_tokens: parsed.usage?.cache_read_tokens ?? 0,
      reasoning_tokens: parsed.usage?.reasoning_tokens ?? 0,
      total_tokens: parsed.usage?.total_tokens ?? 0,
      cost_usd: 0,
      incomplete: 0,
      latency_ms: Date.now() - startTime,
      started_at: new Date(startTime).toISOString(),
      finished_at: new Date().toISOString(),
      source_ip: info.clientIp ?? undefined,
      user_agent: info.userAgent ?? undefined,
    });
  }
}
