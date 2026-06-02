import { Config } from "../config";
import { RequestInspector, type RequestInfo } from "./request-inspector";
import { ResponseParser, type ParsedResponse } from "./response-parser";
import { UsageService } from "../storage/service";
import { ApiKeyRepo } from "../storage/api-keys";
import { CanonicalProvider } from "../provider/canonical";
import { ProviderRegistry } from "../provider/registry";
import type { ProviderDefinition, ProviderAuth } from "../provider/registry-schema";
import { ProviderTransforms } from "../provider/transform";
import "../provider/transforms";
import { UpstreamClient } from "../upstream/client";
import { Logger } from "../util/logger";
import type { Usage } from "../usage";
import { Shutdown } from "../runtime/shutdown";
import { PerfMetrics } from "./perf-metrics";

const logger = Logger.fromConfig().child({ component: "pass-through" });
const FINALIZE_ATTEMPTS = 3;
const FINALIZE_RETRY_BACKOFF_MS = 50;
const MAX_SSE_LINE_BYTES = 1_048_576;
const MAX_RESPONSE_BODY_BYTES = 52_428_800;

type ParsedUsage = ParsedResponse["usage"];
type FetchUpstream = typeof UpstreamClient.fetch;
type BodyReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

interface BodyBuildResult {
  body: BodyInit | null;
  rewritten: boolean;
}

interface ResolvedUpstream {
  provider: ProviderDefinition;
  url: string;
}

interface LifecycleContext {
  id: number;
  requestId: string;
  startTime: number;
  startedAt: string;
  proxyApiKeyId?: number;
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
  handle: LifecycleHandle;
}

interface LifecycleHandle extends Shutdown.ActiveLifecycleHandle {
  finish(): void;
}

export interface ResolvedProxyApiKey {
  readonly id: number;
  readonly allowedProviders: string[] | null;
  readonly allowedAccounts: string[] | null;
}

// Handler owns required public-route authentication. Pass-through keeps a
// best-effort header mode only for internal callers/tests that need attribution
// without turning it into an ingress auth boundary.
export type ProxyAuthContext =
  | { readonly mode: "resolved"; readonly proxyApiKey: ResolvedProxyApiKey }
  | { readonly mode: "best-effort-header" };

export namespace PassThroughProxy {
  const activeLifecycleHandles = new Set<LifecycleHandle>();

  export interface Dependencies {
    fetch?: FetchUpstream;
  }

  Shutdown.registerActiveLifecycleHandlesProvider(activeLifecycleHandlesSnapshot);

  export function activeLifecycleHandlesSnapshot(): readonly Shutdown.ActiveLifecycleHandle[] {
    return Array.from(activeLifecycleHandles);
  }

  export function create(usageService: UsageService.UsageService, dependencies: Dependencies = {}) {
    const fetchUpstream = dependencies.fetch ?? UpstreamClient.fetch;

    return async function handle(
      req: Request,
      info: RequestInfo,
      authContext: ProxyAuthContext = { mode: "best-effort-header" },
    ): Promise<Response> {
      const startTime = Date.now();
      const proxyApiKey = authContext.mode === "resolved"
        ? authContext.proxyApiKey
        : await resolveProxyApiKey(req.headers, usageService.db);
      if (proxyApiKey) touchProxyApiKeyLastUsed(usageService, proxyApiKey.id);
      const lifecycle = preLog(req, info, usageService, startTime, proxyApiKey?.id ?? null);
      const requestInfo: RequestInfo = { ...info, requestId: lifecycle?.requestId ?? info.requestId };
      const passthroughSignal = lifecycle ? composeSignals([req.signal, lifecycle.handle.signal]) : req.signal;
      let streamHandedOff = false;

      try {
        const upstream = resolveUpstream(requestInfo);
        const providerId = lifecycle?.provider ?? upstream.provider.id;
        if (requiresProviderAuthorization(requestInfo.path) && !isProviderAllowed(providerId, proxyApiKey?.allowedProviders ?? null)) {
          await finalizeOnce(usageService, lifecycle, {
            parsed: { actualModel: null, usage: null },
            status: 403,
            isStreaming: false,
            lifecycleStatus: "error",
            errorMessage: "provider not allowed for this API key",
            errorCode: "provider_not_allowed",
          });
          return new Response(
            JSON.stringify({ error: "provider not allowed for this API key" }),
            { status: 403, headers: { "content-type": "application/json" } },
          );
        }

        const { body, rewritten } = await buildBody(req, requestInfo, upstream.provider);
        const upstreamStartedAt = Date.now();
        const upstreamResponse = await fetchUpstream({
          method: req.method,
          url: upstream.url,
          headers: buildHeaders(req.headers, requestInfo, upstream.provider, rewritten),
          body,
          providerId,
          idempotent: isIdempotentMethod(req.method),
          signal: passthroughSignal,
          timeoutMs: streamFirstByteTimeoutFor(requestInfo),
        });
        const headersReceivedAt = Date.now();
        logger.info("upstream response headers received", {
          event: "passthrough.upstream_headers",
          request_id: requestIdFor(lifecycle, requestInfo),
          path: requestInfo.path,
          provider: providerId,
          status: upstreamResponse.status,
          latency_ms: headersReceivedAt - upstreamStartedAt,
        });

        const isStreaming = upstreamResponse.headers
          .get("content-type")
          ?.includes("text/event-stream") ?? false;

        if (isStreaming) {
          streamHandedOff = true;
          return await handleStreaming(upstreamResponse, requestInfo, usageService, lifecycle, providerId, upstreamStartedAt, headersReceivedAt);
        }

        return await handleNonStreaming(upstreamResponse, requestInfo, usageService, lifecycle, providerId);
      } catch (err) {
        const upstreamBodyTimeout = isUpstreamBodyTimeout(err);
        const aborted = !upstreamBodyTimeout && isAbortLike(err, req.signal);
        const status = upstreamBodyTimeout ? 504 : aborted ? 499 : 502;
        const responseError = aborted
          ? "Request aborted"
          : upstreamBodyTimeout
            ? "Upstream timeout"
            : "Upstream unavailable";
        const message = errorMessage(
          err,
          upstreamBodyTimeout ? "upstream timeout" : aborted ? "request aborted" : "upstream unavailable",
        );
        logger.error("upstream fetch failed", {
          event: "passthrough.upstream_error",
          err,
          path: requestInfo.path,
          request_id: requestIdFor(lifecycle, requestInfo),
          timeout_kind: upstreamBodyTimeout ? "first_body" : undefined,
        });
        await finalizeOnce(usageService, lifecycle, {
          parsed: { actualModel: null, usage: null },
          status,
          isStreaming: false,
          lifecycleStatus: aborted ? "aborted" : "error",
          errorMessage: message,
          errorCode: upstreamBodyTimeout ? "upstream_timeout" : aborted ? "aborted" : "bad_gateway",
        });
        return new Response(
          JSON.stringify({ error: responseError }),
          { status, headers: { "content-type": "application/json" } },
        );
      } finally {
        if (!streamHandedOff && lifecycle && !lifecycle.finalized && !lifecycle.finalizing) {
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
    proxyApiKeyId: number | null,
  ): LifecycleContext | null {
    if (!isLlmRequest(info)) return null;

    const requestId = crypto.randomUUID();
    info.requestId = requestId;
    const provider = providerForRequest(info);
    const tool = RequestInspector.detectTool(info);
    const clientId = RequestInspector.generateClientId(tool, info);
    const startedAt = new Date(startTime).toISOString();
    const msgId = req.headers.get("x-msg-id")
      ?? req.headers.get("x-message-id")
      ?? req.headers.get("x-request-id")
      ?? undefined;
    const source = "proxy";

    let id: number;
    try {
      id = usageService.preLog({
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
        proxy_api_key_id: proxyApiKeyId ?? undefined,
      });
    } catch (err) {
      logger.error("request pre-log failed", {
        event: "lifecycle.prelog_failed",
        err,
        request_id: requestId,
        path: info.path,
      });
      return null;
    }

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
      proxyApiKeyId: proxyApiKeyId ?? undefined,
      finalized: false,
      finalizing: null,
      handle: registerLifecycleHandle(id, requestId),
    };
  }

  function isLlmRequest(info: RequestInfo): boolean {
    if (info.method !== "POST") return false;
    if (info.path === "/v1/images/generations") return false;
    if (info.path === "/v1/chat/completions") return true;
    if (info.path === "/v1/messages") return true;
    if (info.path === "/v1/responses") return true;
    if (info.path === "/api/chat") return true;
    return info.model !== null && info.model.trim() !== "";
  }

  function registerLifecycleHandle(id: number, requestId: string): LifecycleHandle {
    const controller = new AbortController();
    let done = false;
    let resolveDone: () => void = () => undefined;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const handle: LifecycleHandle = {
      id,
      requestId,
      done: donePromise,
      signal: controller.signal,
      abort(reason?: unknown) {
        if (!controller.signal.aborted) controller.abort(reason);
      },
      isDone() {
        return done;
      },
      finish() {
        if (done) return;
        done = true;
        activeLifecycleHandles.delete(handle);
        resolveDone();
      },
    };
    activeLifecycleHandles.add(handle);
    return handle;
  }

  function composeSignals(signals: AbortSignal[]): AbortSignal {
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
  }

  async function buildBody(req: Request, info: RequestInfo, provider: ProviderDefinition): Promise<BodyBuildResult> {
    const providerId = provider.id;
    if (!ProviderTransforms.get(providerId)?.transformBody && !provider.stripProviderField) return { body: req.body, rewritten: false };
    const contentType = req.headers.get("content-type") ?? "";
    // only attempt JSON transform for JSON bodies; binary/multipart pass through unchanged
    if (!contentType.startsWith("application/json") && !contentType.startsWith("text/")) {
      return { body: req.body, rewritten: false };
    }
    const text = await req.text();
    try {
      const parsed = JSON.parse(text) as unknown;
      const withoutProvider = provider.stripProviderField ? stripProviderField(parsed) : parsed;
      const rewritten = ProviderTransforms.applyBody(providerId, withoutProvider, info);
      return { body: JSON.stringify(rewritten), rewritten: true };
    } catch (err) {
      logger.warn("provider body transform failed, forwarding original body", { err, path: info.path, request_id: info.requestId, provider: providerId });
      return { body: text, rewritten: false };
    }
  }


  function stripSpoofableProxyHeaders(headers: Headers): void {
    for (const name of Array.from(headers.keys())) {
      const lower = name.toLowerCase();
      if (lower === "forwarded" || lower.startsWith("x-forwarded-") || lower.startsWith("cf-")) {
        headers.delete(name);
      }
    }
  }

  export function buildHeaders(headers: Headers, info: RequestInfo, provider?: ProviderDefinition, bodyRewritten = false): Headers {
    const result = new Headers(headers);
    result.delete("x-proxy-key");
    result.delete("x-provider");
    result.delete("host");
    result.delete("content-length");
    result.delete("content-encoding");
    result.delete("accept-encoding");
    stripSpoofableProxyHeaders(result);
    const resolvedProvider = provider ?? resolveUpstream(info).provider;
    applyProviderHeaders(result, resolvedProvider);
    applyProviderAuth(result, resolvedProvider);
    if (resolvedProvider.type === "anthropic" && !result.has("anthropic-version")) {
      result.set("anthropic-version", "2023-06-01");
    }
    const providerId = resolvedProvider.id;
    const transformed = ProviderTransforms.applyHeaders(providerId, result, info);
    if (bodyRewritten) transformed.set("content-type", "application/json");
    return transformed;
  }

  function stripProviderField(value: unknown): unknown {
    if (!isRecord(value) || !("provider" in value)) return value;
    const { provider: _provider, ...rest } = value;
    return rest;
  }

  function applyProviderHeaders(headers: Headers, provider: ProviderDefinition): void {
    if (!provider.headers) return;
    for (const [key, value] of Object.entries(provider.headers)) {
      headers.set(key, value);
    }
  }

  function applyProviderAuth(headers: Headers, provider: ProviderDefinition): void {
    const auth = provider.auth ?? "preserve";
    const authType = typeof auth === "string" ? auth : auth.type;

    if (authType === "none") {
      headers.delete("authorization");
      headers.delete("x-api-key");
      return;
    }

    if (authType === "preserve") {
      if (isCliProxyProvider(provider)) headers.set("authorization", `Bearer ${Config.cliProxyApiKey}`);
      return;
    }

    const token = providerAuthToken(auth);
    if (!token) return;

    if (authType === "bearer") {
      headers.delete("x-api-key");
      headers.set(providerAuthHeader(auth, "authorization"), `Bearer ${token}`);
      return;
    }

    headers.delete("authorization");
    headers.set(providerAuthHeader(auth, "x-api-key"), token);
  }

  function providerAuthToken(auth: ProviderAuth): string | null {
    if (typeof auth === "string") return null;
    if (auth.value) return auth.value;
    if (auth.env) return process.env[auth.env]?.trim() || null;
    return null;
  }

  function providerAuthHeader(auth: ProviderAuth, fallback: string): string {
    return typeof auth === "string" ? fallback : auth.header ?? fallback;
  }

  function isCliProxyProvider(provider: ProviderDefinition): boolean {
    return normalizeBaseUrl(provider.upstreamBaseUrl) === normalizeBaseUrl(Config.cliProxyApiUrl);
  }

  function isIdempotentMethod(method: string): boolean {
    return method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "DELETE" || method === "PUT";
  }

  async function handleNonStreaming(
    upstreamResponse: Response,
    info: RequestInfo,
    usageService: UsageService.UsageService,
    lifecycle: LifecycleContext | null,
    providerId: string,
  ): Promise<Response> {
    const contentLength = upstreamResponse.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BODY_BYTES) {
      logger.warn("upstream response body exceeded limit", {
        event: "passthrough.response_body_too_large",
        request_id: requestIdFor(lifecycle, info),
        content_length: contentLength,
        max_bytes: MAX_RESPONSE_BODY_BYTES,
      });
      await finalizeOnce(usageService, lifecycle, {
        parsed: { actualModel: null, usage: null },
        status: 502,
        isStreaming: false,
        lifecycleStatus: "error",
        errorCode: "response_too_large",
        errorMessage: "upstream response body exceeded 50MB limit",
      });
      await upstreamResponse.body?.cancel(new Error("upstream response body exceeded limit"));
      return new Response(JSON.stringify({ error: { type: "proxy_error", message: "upstream response too large" } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    const reader = upstreamResponse.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
            logger.warn("upstream response body exceeded limit", {
              event: "passthrough.response_body_too_large",
              request_id: requestIdFor(lifecycle, info),
              max_bytes: MAX_RESPONSE_BODY_BYTES,
            });
            await finalizeOnce(usageService, lifecycle, {
              parsed: { actualModel: null, usage: null },
              status: 502,
              isStreaming: false,
              lifecycleStatus: "error",
              errorCode: "response_too_large",
              errorMessage: "upstream response body exceeded 50MB limit",
            });
            await reader.cancel(new Error("upstream response body exceeded limit"));
            return new Response(JSON.stringify({ error: { type: "proxy_error", message: "upstream response too large" } }), {
              status: 502,
              headers: { "content-type": "application/json" },
            });
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }

    const allBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      allBytes.set(chunk, offset);
      offset += chunk.length;
    }
    let responseText = new TextDecoder().decode(allBytes);

    const responseContentType = upstreamResponse.headers.get("content-type") ?? "";
    const isBinaryResponse = !responseContentType.startsWith("application/json") && !responseContentType.startsWith("text/");

    if (isBinaryResponse) {
      const lifecycleStatus: Usage.LifecycleStatus = upstreamResponse.status >= 400 ? "error" : "completed";
      await finalizeOnce(usageService, lifecycle, {
        parsed: { actualModel: null, usage: null },
        status: upstreamResponse.status,
        isStreaming: false,
        lifecycleStatus,
        errorMessage: lifecycleStatus === "error" ? upstreamErrorMessage(upstreamResponse.status, "") : undefined,
        errorCode: lifecycleStatus === "error" ? "upstream_error" : undefined,
      });

      return new Response(allBytes, {
        status: upstreamResponse.status,
        headers: {
          "content-type": responseContentType || "application/octet-stream",
        },
      });
    }

    if (upstreamResponse.status < 400) {
      try {
        responseText = ProviderTransforms.applyResponse(providerId, responseText, info);
      } catch (err) {
        logger.warn("provider response transform failed", { err, path: info.path, status: upstreamResponse.status, request_id: requestIdFor(lifecycle, info), provider: providerId });
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

  async function handleStreaming(
    upstreamResponse: Response,
    info: RequestInfo,
    usageService: UsageService.UsageService,
    lifecycle: LifecycleContext | null,
    providerId: string,
    upstreamStartedAt: number = Date.now(),
    headersReceivedAt: number = Date.now(),
  ): Promise<Response> {
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
      return ProviderTransforms.applyStreamLine(providerId, line, info);
    }

    function transformChunk(chunk: Uint8Array): Uint8Array | null {
      const text = decoder.decode(chunk, { stream: true });
      const combined = partialLine + text;
      const lines = combined.split("\n");
      partialLine = lines.pop() ?? "";
      if (partialLine.length > MAX_SSE_LINE_BYTES) {
        logger.warn("SSE partial line exceeds max size, truncating", { event: "passthrough.sse_line_too_long", length: partialLine.length });
        partialLine = "";
      }

      let output = "";
      for (const line of lines) {
        output += `${processLine(line)}\n`;
      }
      return output ? encoder.encode(output) : null;
    }

    function flushPartialLine(): Uint8Array | null {
      const tail = partialLine + decoder.decode();
      partialLine = "";
      return tail ? encoder.encode(processLine(tail)) : null;
    }

    const upstreamReader = upstreamBody.getReader();
    let firstRead: BodyReadResult;
    try {
      firstRead = await upstreamReader.read();
    } catch (err) {
      if (!streamDone) {
        streamDone = true;
        const upstreamBodyTimeout = isUpstreamBodyTimeout(err);
        await finalizeOnce(usageService, lifecycle, {
          parsed: { actualModel, usage: accumulated },
          status: upstreamBodyTimeout ? 504 : upstreamResponse.status,
          isStreaming: true,
          lifecycleStatus: "error",
          errorMessage: errorMessage(err, "stream relay failed"),
          errorCode: upstreamBodyTimeout ? "upstream_timeout" : "stream_error",
        });
      }
      await upstreamReader.cancel(err).catch((cancelErr) => {
        logger.debug("stream cancel after first read failure failed", {
          event: "passthrough.stream_cancel_failed",
          err: cancelErr,
          request_id: requestIdFor(lifecycle, info),
          path: info.path,
        });
      });
      throw err;
    }

    logger.info("stream first chunk received", {
      event: "passthrough.stream_first_chunk",
      request_id: requestIdFor(lifecycle, info),
      path: info.path,
      provider: providerId,
      latency_ms: Date.now() - headersReceivedAt,
      upstream_latency_ms: Date.now() - upstreamStartedAt,
    });

    if (firstRead.done) {
      streamDone = true;
      await finalizeOnce(usageService, lifecycle, {
        parsed: { actualModel, usage: accumulated },
        status: upstreamResponse.status,
        isStreaming: true,
        lifecycleStatus: upstreamResponse.status >= 400 ? "error" : "completed",
        errorMessage: upstreamResponse.status >= 400 ? `upstream HTTP ${upstreamResponse.status}` : undefined,
        errorCode: upstreamResponse.status >= 400 ? "upstream_error" : undefined,
      });
      return new Response(null, {
        status: upstreamResponse.status,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
        },
      });
    }

    UpstreamClient.releaseBodyTimeout(upstreamResponse);

    let queuedFirstChunk: Uint8Array | null = firstRead.value;
    let shutdownAbortError: Error | null = null;

    const onShutdownAbort = () => {
      const reason = lifecycle?.handle.signal.reason;
      const err = reason instanceof Error ? reason : new Error(typeof reason === "string" && reason ? reason : "shutdown");
      shutdownAbortError = err;
      void upstreamReader.cancel(err).catch(() => undefined);
    };
    if (lifecycle) {
      if (lifecycle.handle.signal.aborted) onShutdownAbort();
      else lifecycle.handle.signal.addEventListener("abort", onShutdownAbort, { once: true });
    }

    const outputStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (shutdownAbortError) throw shutdownAbortError;
          while (true) {
            let value: Uint8Array;
            if (queuedFirstChunk) {
              value = queuedFirstChunk;
              queuedFirstChunk = null;
            } else {
              const read = await upstreamReader.read();
              if (read.done) {
                const tail = flushPartialLine();
                if (tail) controller.enqueue(tail);
                streamDone = true;
                await finalizeOnce(usageService, lifecycle, {
                  parsed: { actualModel, usage: accumulated },
                  status: upstreamResponse.status,
                  isStreaming: true,
                  lifecycleStatus: upstreamResponse.status >= 400 ? "error" : "completed",
                  errorMessage: upstreamResponse.status >= 400 ? `upstream HTTP ${upstreamResponse.status}` : undefined,
                  errorCode: upstreamResponse.status >= 400 ? "upstream_error" : undefined,
                });
                controller.close();
                return;
              }
              value = read.value;
            }

            const output = transformChunk(value);
            if (output) {
              controller.enqueue(output);
              return;
            }
          }
        } catch (err) {
          if (!streamDone) {
            streamDone = true;
            const upstreamBodyTimeout = isUpstreamBodyTimeout(err);
            const aborted = !upstreamBodyTimeout && (isAbortLike(err) || lifecycle?.handle.signal.aborted === true);
            await finalizeOnce(usageService, lifecycle, {
              parsed: { actualModel, usage: accumulated },
              status: upstreamBodyTimeout ? 504 : aborted ? 499 : upstreamResponse.status,
              isStreaming: true,
              lifecycleStatus: aborted ? "aborted" : "error",
              errorMessage: errorMessage(err, "stream relay failed"),
              errorCode: upstreamBodyTimeout ? "upstream_timeout" : aborted ? "aborted" : "stream_error",
            });
          }
          controller.error(err);
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
        await upstreamReader.cancel(reason).catch((err) => {
          logger.error("stream cancel failed", { event: "passthrough.flush_error", err, request_id: requestIdFor(lifecycle, info), path: info.path });
        });
      },
    }, { highWaterMark: 0 });

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
    lifecycle: LifecycleContext | null,
    fields: {
      parsed: ParsedResponse;
      status: number;
      isStreaming: boolean;
      lifecycleStatus: Usage.LifecycleStatus;
      errorMessage?: string;
      errorCode?: string;
    },
  ): Promise<void> {
    if (!lifecycle) return;
    if (lifecycle.finalized) return;
    if (lifecycle.finalizing) return lifecycle.finalizing;

    lifecycle.finalizing = (async () => {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - lifecycle.startTime;
      const usage = fields.parsed.usage;
      const model = fields.parsed.actualModel ?? lifecycle.model;
      const actualProvider = fields.parsed.actualModel
        ? CanonicalProvider.fromModel(fields.parsed.actualModel) ?? lifecycle.provider
        : lifecycle.provider;
      const log: Omit<Usage.RequestLog, "id"> = {
        request_id: lifecycle.requestId,
        provider: lifecycle.provider,
        model,
        actual_model: fields.parsed.actualModel ?? undefined,
        actual_provider: actualProvider,
        cost_provider: actualProvider,
        cost_model: model,
        proxy_api_key_id: lifecycle.proxyApiKeyId,
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
        latency_ms: durationMs,
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
      PerfMetrics.observeProxyRequest({
        provider: lifecycle.provider,
        status: fields.status,
        lifecycleStatus: fields.lifecycleStatus,
        streamed: fields.isStreaming,
        durationMs,
      });

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
      } finally {
        lifecycle.handle.finish();
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

  function requestIdFor(lifecycle: LifecycleContext | null, info: RequestInfo): string | undefined {
    return lifecycle?.requestId ?? info.requestId;
  }

  function providerForRequest(info: RequestInfo): string {
    return resolveUpstream(info).provider.id;
  }

  function resolveUpstream(info: RequestInfo): ResolvedUpstream {
    const provider = ProviderRegistry.resolve({ path: info.path, model: info.model, provider: info.provider });
    if (provider) return { provider, url: upstreamUrl(provider, info.path) };

    const providerId = CanonicalProvider.resolve(info.model, info.path);
    const fallback: ProviderDefinition = {
      id: providerId,
      type: providerId === "anthropic" ? "anthropic" : "openai-compatible",
      paths: [info.path],
      upstreamBaseUrl: Config.cliProxyApiUrl,
      upstreamPath: info.path,
      auth: "preserve",
    };
    return { provider: fallback, url: upstreamUrl(fallback, info.path) };
  }

  function upstreamUrl(provider: ProviderDefinition, requestPath: string): string {
    const base = normalizeBaseUrl(provider.upstreamBaseUrl);
    const path = provider.upstreamPath ?? requestPath;
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  }

  function normalizeBaseUrl(value: string): string {
    return value.replace(/\/+$/, "");
  }

  function streamFirstByteTimeoutFor(info: RequestInfo): number | undefined {
    if (!info.isStreaming || info.path !== "/v1/messages") return undefined;
    return Config.upstreamStreamFirstByteTimeoutMs;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
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

  function isUpstreamBodyTimeout(err: unknown): boolean {
    return errorMessage(err, "").includes("upstream_body_timeout");
  }

  function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    if (err instanceof DOMException && err.name === "AbortError") return true;
    if (err instanceof Error) {
      return err.name === "AbortError" || err.message.includes("ECONNRESET") || err.message.toLowerCase().includes("aborted");
    }
    return false;
  }

  function requiresProviderAuthorization(path: string): boolean {
    return path !== "/v1/models";
  }

  function isProviderAllowed(providerId: string, allowedProviders: readonly string[] | null): boolean {
    if (!allowedProviders || allowedProviders.length === 0) return true;
    return allowedProviders.includes(providerId);
  }

  async function resolveProxyApiKey(headers: Headers, db: UsageService.UsageService["db"]): Promise<ResolvedProxyApiKey | null> {
    const proxyApiKey = extractBearerToken(headers);
    if (!proxyApiKey) return null;

    const found = await ApiKeyRepo.findByKeyFull(db, proxyApiKey);
    if (!found) return null;

    return { id: found.id, allowedProviders: found.allowedProviders, allowedAccounts: found.allowedAccounts };
  }

  function extractBearerToken(headers: Headers): string | null {
    const authorization = headers.get("authorization")?.trim();
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim();
    return token || null;
  }

  function touchProxyApiKeyLastUsed(usageService: UsageService.UsageService, id: number): void {
    try {
      ApiKeyRepo.touchLastUsed(usageService.db, id);
    } catch (err) {
      logger.warn("proxy API key last-used update failed", { event: "proxy_api_key.touch_failed", err, proxy_api_key_id: id });
    }
  }
}
