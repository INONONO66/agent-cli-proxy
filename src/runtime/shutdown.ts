import type { Database } from "bun:sqlite";
import { Storage } from "../storage/db";
import { RequestRepo } from "../storage/repo";
import { Logger } from "../util/logger";

export namespace Shutdown {
  export type Signal = "SIGTERM" | "SIGINT" | "SIGHUP";

  export interface ServerLike {
    readonly pendingRequests: number;
    readonly pendingWebSockets: number;
    stop(closeActiveConnections?: boolean): void;
  }

  export interface SupervisorLike {
    stopAll(timeoutMs?: number): Promise<void>;
  }

  export interface Options {
    server: ServerLike;
    db: Database;
    supervisor: SupervisorLike;
    drainMs?: number;
    hardKillMs?: number;
    exit?: (code: number) => void;
    logger?: Logger.Logger;
  }

  const DEFAULT_DRAIN_MS = 10_000;
  const DEFAULT_HARD_KILL_MS = 15_000;
  const POLL_MS = 25;
  const EXIT_CODES: Record<Signal, number> = {
    SIGINT: 0,
    SIGTERM: 143,
    SIGHUP: 129,
  };

  type RegisteredHandler = {
    signal: Signal;
    handler: () => void;
  };

  let handlersRegistered = false;
  let registeredHandlers: RegisteredHandler[] = [];
  let shutdownPromise: Promise<number> | null = null;
  let shutdownStarted = false;

  export function register(options: Options): Promise<number> {
    if (handlersRegistered) return shutdownPromise ?? new Promise(() => undefined);

    handlersRegistered = true;
    shutdownPromise = new Promise<number>((resolve) => {
      for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
        const handler = () => {
          if (!shutdownStarted) {
            shutdownStarted = true;
            void run(signal, options).then(resolve);
          }
        };
        process.on(signal, handler);
        registeredHandlers.push({ signal, handler });
      }
    });

    return shutdownPromise;
  }

  export function __resetForTests(): void {
    for (const { signal, handler } of registeredHandlers) {
      process.removeListener(signal, handler);
    }
    registeredHandlers = [];
    handlersRegistered = false;
    shutdownPromise = null;
    shutdownStarted = false;
  }

  export function __runForTests(signal: Signal, options: Options): Promise<number> {
    return run(signal, options);
  }

  async function run(signal: Signal, options: Options): Promise<number> {
    const logger = (options.logger ?? Logger.fromConfig()).child({ component: "shutdown" });
    const drainMs = normalizeTimeout(options.drainMs, DEFAULT_DRAIN_MS);
    const hardKillMs = normalizeTimeout(options.hardKillMs, DEFAULT_HARD_KILL_MS);
    const exit = options.exit ?? ((code: number) => process.exit(code));
    const startedAt = Date.now();
    const exitCode = EXIT_CODES[signal];

    logger.info("shutdown signal", { event: "shutdown.signal", signal });

    try {
      options.server.stop(false);
      await drainServer(options.server, logger, startedAt, drainMs, hardKillMs);

      const supervisorTimeoutMs = Math.max(1, hardKillMs - (Date.now() - startedAt));
      await options.supervisor.stopAll(supervisorTimeoutMs);

      const abortedRows = finalizePendingRows(options.db);
      logger.info("shutdown finalize", { event: "shutdown.finalize", aborted_rows: abortedRows });

      options.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      logger.info("shutdown checkpoint", { event: "shutdown.checkpoint" });
    } catch (err) {
      logger.error("shutdown error", { event: "shutdown.error", err });
    } finally {
      try {
        options.db.close();
      } catch (err) {
        logger.error("shutdown db close failed", { event: "shutdown.close_error", err });
      }

      logger.info("shutdown complete", {
        event: "shutdown.complete",
        exit_code: exitCode,
        total_ms: Date.now() - startedAt,
      });
      exit(exitCode);
    }

    return exitCode;
  }

  async function drainServer(
    server: ServerLike,
    logger: Logger.Logger,
    startedAt: number,
    drainMs: number,
    hardKillMs: number,
  ): Promise<void> {
    while (true) {
      const pendingRequests = server.pendingRequests;
      const pendingWebSockets = server.pendingWebSockets;
      const elapsedMs = Date.now() - startedAt;

      if (pendingRequests === 0 && pendingWebSockets === 0) {
        logger.info("shutdown drain", {
          event: "shutdown.drain",
          pending_requests: pendingRequests,
          pending_websockets: pendingWebSockets,
          elapsed_ms: elapsedMs,
        });
        return;
      }

      if (elapsedMs >= hardKillMs) {
        const remaining = pendingRequests + pendingWebSockets;
        logger.warn("shutdown hard kill", { event: "shutdown.hard_kill", remaining });
        server.stop(true);
        logger.info("shutdown drain", {
          event: "shutdown.drain",
          pending_requests: server.pendingRequests,
          pending_websockets: server.pendingWebSockets,
          elapsed_ms: Date.now() - startedAt,
        });
        return;
      }

      if (elapsedMs >= drainMs) {
        logger.info("shutdown drain", {
          event: "shutdown.drain",
          pending_requests: pendingRequests,
          pending_websockets: pendingWebSockets,
          elapsed_ms: elapsedMs,
        });
        return;
      }

      await sleep(Math.min(POLL_MS, drainMs - elapsedMs, hardKillMs - elapsedMs));
    }
  }

  function finalizePendingRows(db: Database): number {
    const rows = db
      .prepare("SELECT id FROM request_logs WHERE lifecycle_status = 'pending'")
      .all() as Array<{ id: number }>;
    const finalizedAt = new Date().toISOString();

    Storage.runWriteWithRetry(db, () => {
      for (const row of rows) {
        RequestRepo.updateLifecycle(db, row.id, {
          lifecycle_status: "aborted",
          error_message: "shutdown",
          finalized_at: finalizedAt,
        });
      }
    });

    return rows.length;
  }

  function normalizeTimeout(value: number | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0) return fallback;
    return value;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
}
