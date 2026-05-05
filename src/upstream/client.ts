import { Config } from "../config";
import { Logger } from "../util/logger";

export namespace UpstreamClient {
  export const DEFAULT_UPSTREAM_TIMEOUT_MS = 300_000;
  export const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

  export type ErrorCode =
    | "network"
    | "5xx"
    | "aborted"
    | "aborted-due-to-timeout"
    | "short-circuit";

  export interface NormalizedError {
    code: ErrorCode;
    status: number;
    providerId: string;
    retryable: boolean;
    cause: unknown;
  }

  export interface FetchOptions {
    method: string;
    url: string | URL;
    headers?: HeadersInit;
    body?: BodyInit | null;
    providerId: string;
    idempotent?: boolean;
    signal?: AbortSignal;
  }

  type BreakerState = "closed" | "open" | "half-open";

  interface CircuitBreaker {
    state: BreakerState;
    failures: number;
    openedAt: number;
  }

  type TimeoutKind = "connect" | "total";

  const MAX_RETRIES = 2;
  const OPEN_AFTER_FAILURES = 5;
  const HALF_OPEN_AFTER_MS = 30_000;

  const breakers = new Map<string, CircuitBreaker>();

  let logger = Logger.fromConfig().child({ component: "upstream-client" });
  let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  let now = (): number => Date.now();
  let random = (): number => Math.random();

  export async function fetch(options: FetchOptions): Promise<Response> {
    const providerId = options.providerId || "unknown";
    const breaker = breakerFor(providerId);
    const breakerState = currentBreakerState(breaker);
    if (breakerState === "open") {
      const normalized = normalizeShortCircuit(providerId);
      logger.warn("upstream circuit breaker open", {
        event: "upstream.short_circuit",
        ...withoutCause(normalized),
      });
      logFailure(normalized, 0, false);
      return normalizedResponse(normalized);
    }

    const streaming = isStreamingRequest(options);
    const idempotent = options.idempotent === true;
    let attempt = 0;

    while (true) {
      const timeout = createTimeoutSignal(Config.upstreamTimeoutMs, Config.upstreamConnectTimeoutMs);
      const signal = composeSignals([timeout.signal, options.signal]);
      try {
        const response = await globalThis.fetch(options.url, {
          method: options.method,
          headers: options.headers,
          body: options.body,
          signal,
        });
        timeout.clear();

        if (response.status >= 500) {
          const normalized = normalizeHttpFailure(response, providerId, canRetry(idempotent, streaming));
          const retrying = shouldRetry(normalized, attempt, streaming, idempotent);
          logFailure(normalized, attempt, retrying);
          if (retrying) {
            await discardResponse(response);
            await sleep(backoffMs(attempt));
            attempt += 1;
            continue;
          }
          recordFailure(breaker);
          return response;
        }

        recordSuccess(breaker);
        return response;
      } catch (err) {
        timeout.clear();
        const normalized = normalizeThrownFailure(err, providerId, canRetry(idempotent, streaming), timeout.kind);
        const retrying = shouldRetry(normalized, attempt, streaming, idempotent);
        logFailure(normalized, attempt, retrying);
        if (retrying) {
          await sleep(backoffMs(attempt));
          attempt += 1;
          continue;
        }
        recordFailure(breaker);
        return normalizedResponse(normalized);
      }
    }
  }

  export function __resetForTests(): void {
    breakers.clear();
    logger = Logger.fromConfig().child({ component: "upstream-client" });
    sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    now = (): number => Date.now();
    random = (): number => Math.random();
  }

  export function __setTestHooks(hooks: {
    logger?: Logger.Logger;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    random?: () => number;
  }): void {
    if (hooks.logger) logger = hooks.logger;
    if (hooks.sleep) sleep = hooks.sleep;
    if (hooks.now) now = hooks.now;
    if (hooks.random) random = hooks.random;
  }

  function breakerFor(providerId: string): CircuitBreaker {
    const existing = breakers.get(providerId);
    if (existing) return existing;
    const created: CircuitBreaker = { state: "closed", failures: 0, openedAt: 0 };
    breakers.set(providerId, created);
    return created;
  }

  function currentBreakerState(breaker: CircuitBreaker): BreakerState {
    if (breaker.state === "open" && now() - breaker.openedAt >= HALF_OPEN_AFTER_MS) {
      breaker.state = "half-open";
    }
    return breaker.state;
  }

  function recordFailure(breaker: CircuitBreaker): void {
    if (breaker.state === "half-open") {
      breaker.state = "open";
      breaker.openedAt = now();
      breaker.failures = OPEN_AFTER_FAILURES;
      return;
    }

    breaker.failures += 1;
    if (breaker.failures >= OPEN_AFTER_FAILURES) {
      breaker.state = "open";
      breaker.openedAt = now();
    }
  }

  function recordSuccess(breaker: CircuitBreaker): void {
    breaker.state = "closed";
    breaker.failures = 0;
    breaker.openedAt = 0;
  }

  function canRetry(idempotent: boolean, streaming: boolean): boolean {
    return idempotent && !streaming;
  }

  function shouldRetry(
    failure: NormalizedError,
    attempt: number,
    streaming: boolean,
    idempotent: boolean,
  ): boolean {
    if (!canRetry(idempotent, streaming)) return false;
    if (attempt >= MAX_RETRIES) return false;
    return failure.code === "network" || failure.code === "5xx" || failure.code === "aborted-due-to-timeout";
  }

  function backoffMs(attempt: number): number {
    const jitter = Math.floor(random() * 100);
    return Math.min((2 ** attempt) * 200 + jitter, 5_000);
  }

  function createTimeoutSignal(totalMs: number, connectMs: number): {
    signal: AbortSignal;
    clear: () => void;
    readonly kind: TimeoutKind | null;
  } {
    const controller = new AbortController();
    let kind: TimeoutKind | null = null;
    const abort = (nextKind: TimeoutKind): void => {
      if (controller.signal.aborted) return;
      kind = nextKind;
      controller.abort(new Error(`upstream ${nextKind} timeout`));
    };
    const connectTimer = setTimeout(() => abort("connect"), connectMs);
    const totalTimer = setTimeout(() => abort("total"), totalMs);
    return {
      signal: controller.signal,
      clear() {
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
      },
      get kind() {
        return kind;
      },
    };
  }

  function composeSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
    const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
    if (active.length === 1) return active[0];
    const abortSignal = AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal };
    if (typeof abortSignal.any === "function") return abortSignal.any(active);

    const controller = new AbortController();
    const abort = (signal: AbortSignal): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    for (const signal of active) {
      if (signal.aborted) {
        abort(signal);
        break;
      }
      signal.addEventListener("abort", () => abort(signal), { once: true });
    }
    return controller.signal;
  }

  function isStreamingRequest(options: FetchOptions): boolean {
    if (options.body instanceof ReadableStream) return true;
    const headers = new Headers(options.headers);
    const accept = headers.get("accept")?.toLowerCase() ?? "";
    const contentType = headers.get("content-type")?.toLowerCase() ?? "";
    return accept.includes("text/event-stream") || contentType.includes("text/event-stream");
  }

  function normalizeHttpFailure(response: Response, providerId: string, retryable: boolean): NormalizedError {
    return {
      code: "5xx",
      status: response.status,
      providerId,
      retryable,
      cause: { statusText: response.statusText },
    };
  }

  function normalizeThrownFailure(
    err: unknown,
    providerId: string,
    retryable: boolean,
    timeoutKind: TimeoutKind | null,
  ): NormalizedError {
    if (timeoutKind) {
      return {
        code: "aborted-due-to-timeout",
        status: 504,
        providerId,
        retryable,
        cause: { timeoutKind, error: serializeCause(err) },
      };
    }
    if (isAbortError(err)) {
      return {
        code: "aborted",
        status: 499,
        providerId,
        retryable: false,
        cause: serializeCause(err),
      };
    }
    return {
      code: "network",
      status: 503,
      providerId,
      retryable,
      cause: serializeCause(err),
    };
  }

  function normalizeShortCircuit(providerId: string): NormalizedError {
    return {
      code: "short-circuit",
      status: 503,
      providerId,
      retryable: false,
      cause: "circuit breaker open",
    };
  }

  function isAbortError(err: unknown): boolean {
    return err instanceof DOMException && err.name === "AbortError";
  }

  function logFailure(failure: NormalizedError, attempt: number, retrying: boolean): void {
    logger.error("upstream failure", {
      event: "upstream.error",
      ...withoutCause(failure),
      cause: failure.cause,
      attempt,
      max_retries: MAX_RETRIES,
      retrying,
    });
  }

  function withoutCause(failure: NormalizedError): Omit<NormalizedError, "cause"> {
    const { cause: _cause, ...rest } = failure;
    return rest;
  }

  function normalizedResponse(failure: NormalizedError): Response {
    return new Response(JSON.stringify({ error: { ...withoutCause(failure), cause: failure.cause } }), {
      status: failure.status,
      headers: { "content-type": "application/json" },
    });
  }

  function serializeCause(err: unknown): unknown {
    if (err instanceof Error) {
      return { name: err.name, message: err.message };
    }
    return err;
  }

  async function discardResponse(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort cleanup before retrying a failed response.
    }
  }
}
