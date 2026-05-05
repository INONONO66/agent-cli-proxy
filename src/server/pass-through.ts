import { Config } from "../config";
import { RequestInspector, type RequestInfo } from "./request-inspector";
import { ResponseParser, type ParsedResponse } from "./response-parser";
import { UsageService } from "../storage/service";
import { Anthropic } from "../provider/anthropic";
import { rewriteRequestBody, stripToolPrefix, stripToolPrefixFromLine } from "../provider/anthropic/transform";
import { UpstreamClient } from "../upstream/client";
import { Logger } from "../util/logger";
import type { Usage } from "../usage";

const logger = Logger.fromConfig().child({ component: "pass-through" });
const FINALIZE_ATTEMPTS = 3;
const FINALIZE_RETRY_BACKOFF_MS = 50;

type ParsedUsage = ParsedResponse["usage"];
type FetchUpstream = typeof UpstreamClient.fetch;

interface BodyBuildResult {
  body: BodyInit | null;
  rewritten: boolean;
}

interface LifecycleContext {
  id: number;
  requestId: string;
  startTime: number;
  startedAt: string;
  provider: string;
  model: string;
  tool: string;
  clientId: string;
  path: string;
  userAgent?: string;
  sourceIp?: string;
  agent?: string;
  source: string;
  msgId?: string;
  finalized: boolean;
  finalizing: Promise<void> | null;
}

export namespace PassThroughProxy {
  export interface Dependencies {
    fetch?: FetchUpstream;
  }

  export function create(usageService: UsageService.UsageService, dependencies: Dependencies = {}) {
    const fetchUpstream = dependencies.fetch ?? UpstreamClient.fetch;

    return async function handle(req: Request, info: RequestInfo): Promise<Response> {
      const startTime = Date.now();
      const lifecycle = preLog(req, info, usageService, startTime);
      const requestInfo: RequestInfo = { ...info, requestId: lifecycle.requestId };
      const upstreamUrl = `${Config.cliProxyApiUrl}${requestInfo.path}`;
      let streamHandedOff = false;

      try {
        const { body, rewritten } = await buildBody(req, requestInfo);
        const upstreamResponse = await fetchUpstream({
          method: req.method,
          url: upstreamUrl,
          headers: buildHeaders(req.headers, requestInfo, rewritten),
          body,
          providerId: lifecycle.provider,
          idempotent: isIdempotentMethod(req.method),
          signal: req.signal,
        });

        const isStreaming = upstreamResponse.headers
          .get("content-type")
          ?.includes("text/event-stream") ?? false;

        if (isStreaming) {
          streamHandedOff = true;
          return handleStreaming(upstreamResponse, requestInfo, usageService, lifecycle);
        }

        return await handleNonStreaming(upstreamResponse, requestInfo, usageService, lifecycle);
      } catch (err) {
        const aborted = isAbortLike(err, req.signal);
        const status = aborted ? 499 : 502;
        const message = errorMessage(err, aborted ? "request aborted" : "upstream unavailable");
        logger.error("upstream fetch failed", { event: "passthrough.upstream_error", err, path: requestInfo.path, request_id: lifecycle.requestId });
        await finalizeOnce(usageService, lifecycle, {
          parsed: { actualModel: null, usage: null },
          status,
          isStreaming: false,
          lifecycleStatus: aborted ? "aborted" : "error",
          errorMessage: message,
          errorCode: aborted ? "aborted" : "bad_gateway",
        });
        return new Response(
          JSON.stringify({ error: aborted ? "Request aborted" : "Upstream unavailable" }),
          { status, headers: { "content-type": "application/json" } },
        );
      } finally {
        if (!streamHandedOff && !lifecycle.finalized && !lifecycle.finalizing) {
          await finalizeOnce(usageService, lifecycle, {
            parsed: { actualModel: null, usage: null },
            status: 500,
            isStreaming: false,
            lifecycleStatus: "error",
            errorMessage: "unhandled passthrough exit",
            errorCode: "internal_error",
          });
        }
      }
    };
  }

  function preLog(
    req: Request,
    info: RequestInfo,
    usageService: UsageService.UsageService,
    startTime: number,
  ): LifecycleContext {
    const requestId = crypto.randomUUID();
    info.requestId = requestId;
    const provider = providerForPath(info.path);
    const tool = RequestInspector.detectTool(info);
    const clientId = RequestInspector.generateClientId(tool, info);
    const startedAt = new Date(startTime).toISOString();
    const msgId = req.headers.get("x-msg-id")
      ?? req.headers.get("x-message-id")
      ?? req.headers.get("x-request-id")
      ?? undefined;
    const source = "proxy";

    const id = usageService.preLog({
      request_id: requestId,
      provider,
      model: info.model ?? "unknown",
      tool,
      client_id: clientId,
      path: info.path,
      streamed: info.isStreaming ? 1 : 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      incomplete: 0,
      started_at: startedAt,
      meta_json: JSON.stringify({ method: info.method, originator: info.originator, session_id: info.sessionId }),
      user_agent: info.userAgent ?? undefined,
      source_ip: info.clientIp ?? undefined,
      lifecycle_status: "pending",
      cost_status: "unresolved",
      agent: info.agentName ?? undefined,
      source,
      msg_id: msgId,
    });

    logger.info("request pre-logged", {
      event: "lifecycle.pre_logged",
      request_id: requestId,
      row_id: id,
      provider,
      model: info.model ?? "unknown",
      path: info.path,
      tool,
      client_id: clientId,
    });

    return {
      id,
      requestId,
      startTime,
      startedAt,
      provider,
      model: info.model ?? "unknown",
      tool,
      clientId,
      path: info.path,
      userAgent: info.userAgent ?? undefined,
      sourceIp: info.clientIp ?? undefined,
      agent: info.agentName ?? undefined,
      source,
      msgId,
      finalized: false,
      finalizing: null,
    };
  }

  async function buildBody(req: Request, info: RequestInfo): Promise<BodyBuildResult> {
    if (!info.path.includes("messages")) return { body: req.body, rewritten: false };
    const text = await req.text();
    try {
      const rewritten = rewriteRequestBody(JSON.parse(text) as Anthropic.Request);
      return { body: JSON.stringify(rewritten), rewritten: true };
    } catch (err) {
      logger.warn("anthropic rewrite failed, forwarding original body", { err, path: info.path, request_id: info.requestId });
      return { body: text, rewritten: false };
    }
  }

  export function buildHeaders(headers: Headers, info: RequestInfo, bodyRewritten = false): Headers {
    const result = new Headers(headers);
    result.set("authorization", `Bearer ${Config.cliProxyApiKey}`);
    result.delete("host");
    result.delete("content-length");
    result.delete("content-encoding");
    result.delete("accept-encoding");
    if (info.path.includes("messages")) {
      for (const [key, value] of Object.entries(Anthropic.buildClaudeCodeHeaders())) {
        result.set(key, value);
      }
      if (bodyRewritten) result.set("content-type", "application/json");
    }
    return result;
  }

  function isIdempotentMethod(method: string): boolean {
    return method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "DELETE" || method === "PUT";
  }

  async function handleNonStreaming(
    upstreamResponse: Response,
    info: RequestInfo,
    usageService: UsageService.UsageService,
    lifecycle: LifecycleContext,
  ): Promise<Response> {
    let responseText = await upstreamResponse.text();
    if (info.path.includes("messages") && upstreamResponse.status < 400) {
      try {
        responseText = JSON.stringify(stripToolPrefix(JSON.parse(responseText) as Anthropic.Response));
      } catch (err) {
        logger.warn("anthropic response transform failed", { err, path: info.path, status: upstreamResponse.status, request_id: lifecycle.requestId });
      }
    }

    const parsed = ResponseParser.parseResponseBody(responseText);
    const lifecycleStatus: Usage.LifecycleStatus = upstreamResponse.status >= 400 ? "error" : "completed";
    await finalizeOnce(usageService, lifecycle, {
      parsed,
      status: upstreamResponse.status,
      isStreaming: false,
      lifecycleStatus,
      errorMessage: lifecycleStatus === "error" ? upstreamErrorMessage(upstreamResponse.status, responseText) : undefined,
      errorCode: lifecycleStatus === "error" ? "upstream_error" : undefined,
    });

    return new Response(responseText, {
      status: upstreamResponse.status,
      headers: {
        "content-type": upstreamResponse.headers.get("content-type") ?? "application/json",
      },
    });
  }

  function handleStreaming(
    upstreamResponse: Response,
    info: RequestInfo,
    usageService: UsageService.UsageService,
    lifecycle: LifecycleContext,
  ): Response {
    const upstreamBody = upstreamResponse.body;
    if (!upstreamBody) {
      void finalizeOnce(usageService, lifecycle, {
        parsed: { actualModel: null, usage: null },
        status: upstreamResponse.status,
        isStreaming: true,
        lifecycleStatus: upstreamResponse.status >= 400 ? "error" : "completed",
        errorMessage: upstreamResponse.status >= 400 ? `upstream HTTP ${upstreamResponse.status}` : undefined,
        errorCode: upstreamResponse.status >= 400 ? "upstream_error" : undefined,
      });
      return new Response(null, { status: upstreamResponse.status });
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let partialLine = "";
    let accumulated: ParsedUsage = null;
    let actualModel: string | null = null;
    let streamDone = false;

    function processLine(line: string): string {
      if (line.startsWith("data: ")) {
        const dataContent = line.slice(6);
        const parsed = ResponseParser.parseSSELine(dataContent);
        if (parsed.actualModel) actualModel = parsed.actualModel;
        if (parsed.usage) accumulated = mergeUsage(accumulated, parsed.usage);
      }
      return info.path.includes("messages") ? stripToolPrefixFromLine(line) : line;
    }

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        const combined = partialLine + text;
        const lines = combined.split("\n");
        partialLine = lines.pop() ?? "";

        let output = "";
        for (const line of lines) {
          output += `${processLine(line)}\n`;
        }
        if (output) controller.enqueue(encoder.encode(output));
      },
      async flush(controller) {
        try {
          const tail = partialLine + decoder.decode();
          partialLine = "";
          if (tail) controller.enqueue(encoder.encode(processLine(tail)));
          streamDone = true;
          await finalizeOnce(usageService, lifecycle, {
            parsed: { actualModel, usage: accumulated },
            status: upstreamResponse.status,
            isStreaming: true,
            lifecycleStatus: upstreamResponse.status >= 400 ? "error" : "completed",
            errorMessage: upstreamResponse.status >= 400 ? `upstream HTTP ${upstreamResponse.status}` : undefined,
            errorCode: upstreamResponse.status >= 400 ? "upstream_error" : undefined,
          });
        } catch (err) {
          logger.error("stream flush failed", { event: "passthrough.flush_error", err, request_id: lifecycle.requestId, path: info.path });
          await finalizeOnce(usageService, lifecycle, {
            parsed: { actualModel, usage: accumulated },
            status: 499,
            isStreaming: true,
            lifecycleStatus: "aborted",
            errorMessage: errorMessage(err, "stream flush failed"),
            errorCode: "aborted",
          });
          throw err;
        }
      },
    });

    const transformedStream = upstreamBody.pipeThrough(transform);
    let transformedReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const outputStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = transformedStream.getReader();
        transformedReader = reader;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          if (!streamDone) {
            streamDone = true;
            await finalizeOnce(usageService, lifecycle, {
              parsed: { actualModel, usage: accumulated },
              status: isAbortLike(err) ? 499 : upstreamResponse.status,
              isStreaming: true,
              lifecycleStatus: isAbortLike(err) ? "aborted" : "error",
              errorMessage: errorMessage(err, "stream relay failed"),
              errorCode: isAbortLike(err) ? "aborted" : "stream_error",
            });
          }
          controller.error(err);
        } finally {
          transformedReader = null;
        }
      },
      async cancel(reason) {
        if (!streamDone) {
          streamDone = true;
          await finalizeOnce(usageService, lifecycle, {
            parsed: { actualModel, usage: accumulated },
            status: 499,
            isStreaming: true,
            lifecycleStatus: "aborted",
            errorMessage: errorMessage(reason, "client aborted stream"),
            errorCode: "aborted",
          });
        }
        await transformedReader?.cancel(reason).catch((err) => {
          logger.error("stream cancel failed", { event: "passthrough.flush_error", err, request_id: lifecycle.requestId, path: info.path });
        });
      },
    });

    return new Response(outputStream, {
      status: upstreamResponse.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  }

  function mergeUsage(
    acc: ParsedUsage,
    partial: NonNullable<ParsedUsage>,
  ): NonNullable<ParsedUsage> {
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

  async function finalizeOnce(
    usageService: UsageService.UsageService,
    lifecycle: LifecycleContext,
    fields: {
      parsed: ParsedResponse;
      status: number;
      isStreaming: boolean;
      lifecycleStatus: Usage.LifecycleStatus;
      errorMessage?: string;
      errorCode?: string;
    },
  ): Promise<void> {
    if (lifecycle.finalized) return;
    if (lifecycle.finalizing) return lifecycle.finalizing;

    lifecycle.finalizing = (async () => {
      const finishedAt = new Date().toISOString();
      const usage = fields.parsed.usage;
      const model = fields.parsed.actualModel ?? lifecycle.model;
      const log: Omit<Usage.RequestLog, "id"> = {
        request_id: lifecycle.requestId,
        provider: lifecycle.provider,
        model,
        actual_model: fields.parsed.actualModel ?? undefined,
        tool: lifecycle.tool,
        client_id: lifecycle.clientId,
        path: lifecycle.path,
        streamed: fields.isStreaming ? 1 : 0,
        status: fields.status,
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
        cache_creation_tokens: usage?.cache_creation_tokens ?? 0,
        cache_read_tokens: usage?.cache_read_tokens ?? 0,
        reasoning_tokens: usage?.reasoning_tokens ?? 0,
        total_tokens: usage?.total_tokens ?? 0,
        cost_usd: 0,
        incomplete: fields.lifecycleStatus === "completed" ? 0 : 1,
        error_code: fields.errorCode,
        latency_ms: Date.now() - lifecycle.startTime,
        started_at: lifecycle.startedAt,
        finished_at: finishedAt,
        user_agent: lifecycle.userAgent,
        source_ip: lifecycle.sourceIp,
        lifecycle_status: fields.lifecycleStatus,
        finalized_at: finishedAt,
        error_message: fields.errorMessage,
        agent: lifecycle.agent,
        source: lifecycle.source,
        msg_id: lifecycle.msgId,
      };
      try {
        const updated = await retryFinalize(() => usageService.finalizeUsage(lifecycle.id, log));
        lifecycle.finalized = true;
        logger.info("request finalized", {
          event: fields.lifecycleStatus === "aborted" ? "lifecycle.aborted" : "lifecycle.finalized",
          request_id: lifecycle.requestId,
          row_id: lifecycle.id,
          updated,
          lifecycle_status: fields.lifecycleStatus,
          status: fields.status,
          path: lifecycle.path,
        });
      } catch (err) {
        logger.error("failed to finalize request log after retries", {
          event: "lifecycle.finalize_failed",
          err,
          request_id: lifecycle.requestId,
          row_id: lifecycle.id,
          lifecycle_status: fields.lifecycleStatus,
          path: lifecycle.path,
        });
        await markFinalizeFailure(usageService, lifecycle, finishedAt, err);
      }
    })();

    await lifecycle.finalizing;
  }

  async function retryFinalize(finalize: () => Promise<boolean>): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= FINALIZE_ATTEMPTS; attempt += 1) {
      try {
        return await finalize();
      } catch (err) {
        lastError = err;
        if (attempt < FINALIZE_ATTEMPTS) await sleep(FINALIZE_RETRY_BACKOFF_MS);
      }
    }
    throw lastError;
  }

  async function markFinalizeFailure(
    usageService: UsageService.UsageService,
    lifecycle: LifecycleContext,
    finalizedAt: string,
    err: unknown,
  ): Promise<void> {
    try {
      const updated = await usageService.markFinalizeFailed(lifecycle.id, {
        finalizedAt,
        errorMessage: `finalize_failed: ${errorMessage(err, "request finalize failed")}`,
      });
      lifecycle.finalized = true;
      logger.error("marked failed finalize request log", {
        event: "lifecycle.finalize_failed",
        request_id: lifecycle.requestId,
        row_id: lifecycle.id,
        updated,
        path: lifecycle.path,
      });
    } catch (fallbackErr) {
      lifecycle.finalized = true;
      logger.error("lost request finalize after fallback failed", {
        event: "lifecycle.finalize_lost",
        err: fallbackErr,
        original_err: err,
        request_id: lifecycle.requestId,
        row_id: lifecycle.id,
        path: lifecycle.path,
      });
    }
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  function providerForPath(path: string): string {
    return path.includes("messages") ? "anthropic" : "openai";
  }

  function upstreamErrorMessage(status: number, body: string): string {
    const trimmed = body.trim().slice(0, 300);
    return trimmed ? `upstream HTTP ${status}: ${trimmed}` : `upstream HTTP ${status}`;
  }

  function errorMessage(err: unknown, fallback: string): string {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === "string" && err) return err;
    return fallback;
  }

  function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    if (err instanceof DOMException && err.name === "AbortError") return true;
    if (err instanceof Error) {
      return err.name === "AbortError" || err.message.includes("ECONNRESET") || err.message.toLowerCase().includes("aborted");
    }
    return false;
  }
}
