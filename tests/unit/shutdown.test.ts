import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Shutdown } from "../../src/runtime/shutdown";
import { Storage } from "../../src/storage/db";
import { RequestRepo } from "../../src/storage/repo";
import { Logger } from "../../src/util/logger";
import type { Usage } from "../../src/usage";

type LogRecord = Record<string, unknown>;

class FakeServer implements Shutdown.ServerLike {
  pendingRequests = 0;
  pendingWebSockets = 0;
  readonly stopCalls: boolean[] = [];

  stop(closeActiveConnections = false): void {
    this.stopCalls.push(closeActiveConnections);
    if (closeActiveConnections) {
      this.pendingRequests = 0;
      this.pendingWebSockets = 0;
    }
  }
}

function captureLogger() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    logger: Logger.create({
      level: "debug",
      sink: {
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
      },
    }),
  };
}

function parseLogs(lines: string[]): LogRecord[] {
  return lines.map((line) => JSON.parse(line) as LogRecord);
}

function tempDbPath(): string {
  return join(tmpdir(), `agent-cli-proxy-shutdown-${crypto.randomUUID()}.db`);
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("ENOENT")) throw err;
    }
  }
}

function baseLog(overrides: Partial<Usage.RequestLog> = {}): Omit<Usage.RequestLog, "id"> {
  return {
    request_id: `req-${crypto.randomUUID()}`,
    provider: "openai",
    model: "gpt-4o",
    tool: "opencode",
    client_id: "opencode-test",
    path: "/v1/chat/completions",
    streamed: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    incomplete: 0,
    started_at: new Date().toISOString(),
    lifecycle_status: "pending",
    cost_status: "unresolved",
    ...overrides,
  };
}

function createSupervisor() {
  const calls: number[] = [];
  return {
    calls,
    supervisor: {
      async stopAll(timeoutMs?: number): Promise<void> {
        calls.push(timeoutMs ?? -1);
      },
    },
  };
}

async function runShutdown(options: {
  server?: FakeServer;
  db?: Database;
  drainMs?: number;
  hardKillMs?: number;
}) {
  const capture = captureLogger();
  const server = options.server ?? new FakeServer();
  const supervisor = createSupervisor();
  const exitCodes: number[] = [];
  const code = await Shutdown.__runForTests("SIGTERM", {
    server,
    db: options.db ?? Storage.initDb(":memory:"),
    supervisor: supervisor.supervisor,
    drainMs: options.drainMs ?? 1,
    hardKillMs: options.hardKillMs ?? 20,
    logger: capture.logger,
    exit: (code) => {
      exitCodes.push(code);
    },
  });
  return {
    code,
    exitCode: exitCodes[0] ?? null,
    server,
    supervisor,
    logs: parseLogs(capture.stdout),
    errors: parseLogs(capture.stderr),
  };
}

afterEach(() => {
  Shutdown.__resetForTests();
});

test("register sets up signal handlers", () => {
  const db = Storage.initDb(":memory:");
  const before = {
    SIGTERM: process.listenerCount("SIGTERM"),
    SIGINT: process.listenerCount("SIGINT"),
    SIGHUP: process.listenerCount("SIGHUP"),
  };

  Shutdown.register({ server: new FakeServer(), db, supervisor: createSupervisor().supervisor });

  expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM + 1);
  expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);
  expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP + 1);
  db.close();
});

test("shutdown finalizes pending rows, checkpoints WAL, closes DB, and exits with signal code", async () => {
  const dbPath = tempDbPath();
  let db = Storage.initDb(dbPath);
  let closed = false;
  const originalClose = db.close.bind(db);
  db.close = () => {
    closed = true;
    originalClose();
  };
  RequestRepo.insert(db, baseLog());

  const result = await runShutdown({ db });

  expect(result.code).toBe(143);
  expect(result.exitCode).toBe(143);
  expect(closed).toBe(true);
  expect(result.server.stopCalls).toEqual([false]);
  expect(result.logs).toContainEqual(expect.objectContaining({ event: "shutdown.checkpoint" }));
  expect(result.logs).toContainEqual(expect.objectContaining({ event: "shutdown.finalize", aborted_rows: 1 }));
  expect(result.logs).toContainEqual(expect.objectContaining({ event: "shutdown.complete", exit_code: 143 }));

  db = Storage.initDb(dbPath);
  const row = db.query("SELECT lifecycle_status, error_message, finalized_at FROM request_logs LIMIT 1").get() as {
    lifecycle_status: string;
    error_message: string;
    finalized_at: string;
  };
  expect(row.lifecycle_status).toBe("aborted");
  expect(row.error_message).toBe("shutdown");
  expect(row.finalized_at).toBeString();
  db.close();
  cleanupDb(dbPath);
});

test("hard-kill timeout force-closes active connections before cleanup", async () => {
  const server = new FakeServer();
  server.pendingRequests = 1;

  const result = await runShutdown({ server, drainMs: 100, hardKillMs: 5 });

  expect(result.server.stopCalls).toEqual([false, true]);
  expect(result.logs).toContainEqual(expect.objectContaining({ event: "shutdown.drain", pending_requests: 0 }));
  expect(result.logs).toContainEqual(expect.objectContaining({ event: "shutdown.complete", exit_code: 143 }));
  expect(result.logs).toContainEqual(expect.objectContaining({ event: "shutdown.hard_kill", remaining: 1 }));
});

test("drain timeout proceeds without blocking forever", async () => {
  const server = new FakeServer();
  server.pendingRequests = 1;

  const result = await runShutdown({ server, drainMs: 5, hardKillMs: 50 });

  expect(result.server.stopCalls).toEqual([false]);
  expect(result.logs).toContainEqual(expect.objectContaining({ event: "shutdown.drain", pending_requests: 1 }));
  expect(result.logs).toContainEqual(expect.objectContaining({ event: "shutdown.complete", exit_code: 143 }));
});

test("repeated register calls do not double-register handlers", () => {
  const firstDb = Storage.initDb(":memory:");
  const secondDb = Storage.initDb(":memory:");
  const before = process.listenerCount("SIGTERM");

  const first = Shutdown.register({ server: new FakeServer(), db: firstDb, supervisor: createSupervisor().supervisor });
  const second = Shutdown.register({ server: new FakeServer(), db: secondDb, supervisor: createSupervisor().supervisor });

  expect(first).toBe(second);
  expect(process.listenerCount("SIGTERM")).toBe(before + 1);
  firstDb.close();
  secondDb.close();
});
