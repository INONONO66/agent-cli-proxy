import { Logger } from "../util/logger";

export namespace Supervisor {
  export interface Options {
    intervalMs: number;
    initialDelayMs?: number;
    jitterRatio?: number;
    maxBackoffMs?: number;
    signal?: AbortSignal;
    runOnStart?: boolean;
  }

  export interface Handle {
    stop(): Promise<void>;
  }

  type LoopState = {
    name: string;
    controller: AbortController;
    done: Promise<void>;
    stopRequested: boolean;
    stopLogged: boolean;
    stop(timeoutMs: number): Promise<void>;
  };

  const DEFAULT_JITTER_RATIO = 0.1;
  const DEFAULT_MAX_BACKOFF_MS = 60_000;
  const DEFAULT_STOP_TIMEOUT_MS = 2_000;

  const registry = new Set<LoopState>();
  let logger = Logger.fromConfig().child({ component: "supervisor" });

  export function run(name: string, fn: () => Promise<void> | void, options: Options): Handle {
    validateOptions(name, options);

    const controller = new AbortController();
    const signal = controller.signal;
    const intervalMs = options.intervalMs;
    const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const runOnStart = options.runOnStart ?? true;
    const initialDelayMs = options.initialDelayMs ?? 0;

    let removeExternalAbort: (() => void) | null = null;
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else {
        const abort = () => controller.abort();
        options.signal.addEventListener("abort", abort, { once: true });
        removeExternalAbort = () => options.signal?.removeEventListener("abort", abort);
      }
    }

    const state: LoopState = {
      name,
      controller,
      done: Promise.resolve(),
      stopRequested: false,
      stopLogged: false,
      async stop(timeoutMs: number) {
        this.stopRequested = true;
        this.controller.abort();
        const stopped = await resolveWithin(this.done, timeoutMs);
        if (stopped) {
          logStopped(this);
          return;
        }
        registry.delete(this);
        logStopTimeout(this, timeoutMs);
      },
    };

    state.done = loop({
      name,
      fn,
      signal,
      intervalMs,
      initialDelayMs,
      jitterRatio,
      maxBackoffMs,
      runOnStart,
    }).finally(() => {
      removeExternalAbort?.();
      registry.delete(state);
      if (state.stopRequested || signal.aborted) logStopped(state);
    });

    registry.add(state);
    logger.info("loop started", { name, event: "loop.started", interval_ms: intervalMs });

    return {
      stop() {
        return state.stop(DEFAULT_STOP_TIMEOUT_MS);
      },
    };
  }

  export async function stopAll(timeoutMs: number = DEFAULT_STOP_TIMEOUT_MS): Promise<void> {
    const loops = Array.from(registry);
    await Promise.all(loops.map((loopState) => loopState.stop(timeoutMs)));
  }

  export function list(): string[] {
    return Array.from(registry, (loopState) => loopState.name).sort();
  }

  export function __setLoggerForTests(testLogger: Logger.Logger | null): void {
    logger = testLogger ?? Logger.fromConfig().child({ component: "supervisor" });
  }

  async function loop(context: {
    name: string;
    fn: () => Promise<void> | void;
    signal: AbortSignal;
    intervalMs: number;
    initialDelayMs: number;
    jitterRatio: number;
    maxBackoffMs: number;
    runOnStart: boolean;
  }): Promise<void> {
    let consecutiveFailures = 0;
    let nextDelayMs = context.runOnStart
      ? context.initialDelayMs
      : context.initialDelayMs > 0
        ? context.initialDelayMs
        : context.intervalMs;

    while (!context.signal.aborted) {
      if (nextDelayMs > 0) {
        const slept = await sleep(nextDelayMs, context.signal);
        if (!slept) return;
      }

      if (context.signal.aborted) return;

      const startedAt = Date.now();
      try {
        await context.fn();
        const durationMs = Date.now() - startedAt;
        consecutiveFailures = 0;
        logger.debug("loop tick", {
          name: context.name,
          event: "loop.tick",
          duration_ms: durationMs,
        });
        nextDelayMs = applyJitter(context.intervalMs, context.jitterRatio);
      } catch (err) {
        consecutiveFailures += 1;
        const backoffMs = Math.min(
          context.intervalMs * 2 ** consecutiveFailures,
          context.maxBackoffMs,
        );
        nextDelayMs = applyJitter(backoffMs, context.jitterRatio);
        logger.error("loop error", {
          name: context.name,
          event: "loop.error",
          err,
          attempt: consecutiveFailures,
          next_delay_ms: nextDelayMs,
        });
      }
    }
  }

  function validateOptions(name: string, options: Options): void {
    if (!name.trim()) throw new Error("Supervisor loop name is required");
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("Supervisor intervalMs must be a positive finite number");
    }
    if (options.initialDelayMs !== undefined && (!Number.isFinite(options.initialDelayMs) || options.initialDelayMs < 0)) {
      throw new Error("Supervisor initialDelayMs must be a non-negative finite number");
    }
    if (options.jitterRatio !== undefined && (!Number.isFinite(options.jitterRatio) || options.jitterRatio < 0)) {
      throw new Error("Supervisor jitterRatio must be a non-negative finite number");
    }
    if (options.maxBackoffMs !== undefined && (!Number.isFinite(options.maxBackoffMs) || options.maxBackoffMs <= 0)) {
      throw new Error("Supervisor maxBackoffMs must be a positive finite number");
    }
  }

  function applyJitter(delayMs: number, jitterRatio: number): number {
    if (delayMs <= 0 || jitterRatio <= 0) return Math.max(0, Math.round(delayMs));
    const spread = delayMs * jitterRatio;
    const offset = (Math.random() * 2 - 1) * spread;
    return Math.max(0, Math.round(delayMs + offset));
  }

  function sleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        if (timeout) clearTimeout(timeout);
        resolve(false);
      };
      timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function resolveWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function logStopped(state: LoopState): void {
    if (state.stopLogged) return;
    state.stopLogged = true;
    logger.info("loop stopped", { name: state.name, event: "loop.stopped" });
  }

  function logStopTimeout(state: LoopState, timeoutMs: number): void {
    if (state.stopLogged) return;
    state.stopLogged = true;
    logger.warn("loop stop timeout", {
      name: state.name,
      event: "loop.stop_timeout",
      timeout_ms: timeoutMs,
    });
  }
}
