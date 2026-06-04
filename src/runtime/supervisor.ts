import { Database } from "bun:sqlite";
import { QuotaRepo } from "../storage/repo";
import { Logger } from "../util/logger";
import {
  compareLoopName,
  toLoopHealthSnapshot,
  toLoopStatus,
  type LoopHealthSnapshot as SupervisorLoopHealthSnapshot,
  type LoopStatus as SupervisorLoopStatus,
} from "./supervisor-health";
import type { LoopState } from "./supervisor-state";
import { applyJitter, resolveWithin, sleep } from "./supervisor-timing";

export namespace Supervisor {
  export interface Options {
    intervalMs: number;
    initialDelayMs?: number;
    jitterRatio?: number;
    maxBackoffMs?: number;
    maxConsecutiveFailures?: number;
    signal?: AbortSignal;
    runOnStart?: boolean;
  }

  export interface Handle {
    stop(): Promise<void>;
  }

  export type LoopStatus = SupervisorLoopStatus;
  export type LoopHealthSnapshot = SupervisorLoopHealthSnapshot;

  const DEFAULT_JITTER_RATIO = 0.1;
  const DEFAULT_MAX_BACKOFF_MS = 60_000;
  const DEFAULT_STOP_TIMEOUT_MS = 2_000;
  const DEFAULT_MAX_CONSECUTIVE_FAILURES = 100;

  const registry = new Set<LoopState>();
  let logger = Logger.fromConfig().child({ component: "supervisor" });

  export function run(name: string, fn: () => Promise<void> | void, options: Options): Handle {
    validateOptions(name, options);

    const controller = new AbortController();
    const signal = controller.signal;
    const intervalMs = options.intervalMs;
    const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
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
      failed: false,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
      maxConsecutiveFailures,
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
          registry.delete(this);
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
      state,
    }).finally(() => {
      removeExternalAbort?.();
      if (!state.failed) {
        registry.delete(state);
      }
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

  export function statuses(): LoopStatus[] {
    return Array.from(registry, toLoopStatus).sort(compareLoopName);
  }

  export function healthSnapshot(): LoopHealthSnapshot[] {
    const nowMs = Date.now();
    return Array.from(registry, (loopState) => toLoopHealthSnapshot(loopState, nowMs)).sort(compareLoopName);
  }

  export function startQuotaRetentionLoop(
    db: Database,
    options: { signal?: AbortSignal } = {},
  ): Handle {
    return run(
      "quota-retention",
      async () => {
        const deletedCount = QuotaRepo.deleteOlderThan30Days(db);
        logger.info("quota retention cleanup completed", {
          event: "quota.retention_cleanup",
          deleted_count: deletedCount,
        });
      },
      {
        intervalMs: 24 * 60 * 60 * 1000,
        signal: options.signal,
      },
    );
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
    state: LoopState;
    runOnStart: boolean;
  }): Promise<void> {
    const state = context.state;
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
        state.lastSuccessAt = Date.now();
        state.consecutiveFailures = 0;
        const durationMs = Date.now() - startedAt;
        logger.debug("loop tick", {
          name: context.name,
          event: "loop.tick",
          duration_ms: durationMs,
        });
        nextDelayMs = applyJitter(context.intervalMs, context.jitterRatio);
      } catch (err) {
        state.lastErrorAt = Date.now();
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= state.maxConsecutiveFailures) {
          state.failed = true;
          logger.error("loop disabled", {
            name: context.name,
            event: "loop.disabled",
            cause: err,
            total_failures: state.consecutiveFailures,
          });
          return;
        }
        const backoffMs = Math.min(
          context.intervalMs * 2 ** state.consecutiveFailures,
          context.maxBackoffMs,
        );
        nextDelayMs = applyJitter(backoffMs, context.jitterRatio);
        logger.error("loop error", {
          name: context.name,
          event: "loop.error",
          err,
          attempt: state.consecutiveFailures,
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
    if (
      options.maxConsecutiveFailures !== undefined &&
      (!Number.isFinite(options.maxConsecutiveFailures) ||
        !Number.isInteger(options.maxConsecutiveFailures) ||
        options.maxConsecutiveFailures <= 0)
    ) {
      throw new Error("Supervisor maxConsecutiveFailures must be a positive finite integer");
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
