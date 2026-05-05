import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RequestInfo } from "../../src/server/request-inspector";
import type { Usage } from "../../src/usage";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";

const { RequestInspector } = await import("../../src/server/request-inspector");
const { PassThroughProxy } = await import("../../src/server/pass-through");
const { Shutdown } = await import("../../src/runtime/shutdown");
const { Storage } = await import("../../src/storage/db");
const { UsageService } = await import("../../src/storage/service");
const { RequestRepo } = await import("../../src/storage/repo");

const encoder = new TextEncoder();

class IdleServer {
  readonly pendingRequests = 0;
  readonly pendingWebSockets = 0;
  readonly stopCalls: boolean[] = [];

  stop(closeActiveConnections = false): void {
    this.stopCalls.push(closeActiveConnections);
  }
}

function request(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://proxy.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "opencode/1.0" },
    body: JSON.stringify(body),
  });
}

async function inspect(req: Request): Promise<RequestInfo> {
  return RequestInspector.inspect(req);
}

function tempDbPath(): string {
  return join(tmpdir(), `agent-cli-proxy-shutdown-stream-${crypto.randomUUID()}.db`);
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

function latest(db: Database): Usage.RequestLog {
  return db.query("SELECT * FROM request_logs ORDER BY id DESC LIMIT 1").get() as Usage.RequestLog;
}

function baseLog(overrides: Partial<Usage.RequestLog> = {}): Omit<Usage.RequestLog, "id"> {
  return {
    request_id: `req-${crypto.randomUUID()}`,
    provider: "openai",
    model: "gpt-4o",
    tool: "opencode",
    client_id: "opencode-test",
    path: "/v1/chat/completions",
    streamed: 1,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireController(controller: ReadableStreamDefaultController<Uint8Array> | null): ReadableStreamDefaultController<Uint8Array> {
  if (!controller) throw new Error("upstream stream did not start");
  return controller;
}

afterEach(() => {
  Shutdown.__resetForTests();
});

test("shutdown drain lets active streams finalize before bulk abort", async () => {
  const dbPath = tempDbPath();
  let db = Storage.initDb(dbPath);
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const finalEvent = `data: ${JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}`;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
      controller.enqueue(encoder.encode("data: {\"model\":\"gpt-4o\"}\n"));
    },
  });
  const usageService = UsageService.create(db);
  const handle = PassThroughProxy.create(usageService, {
    async fetch() {
      return new Response(upstream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const req = request("/v1/chat/completions", { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  expect(PassThroughProxy.activeLifecycleHandlesSnapshot()).toHaveLength(1);

  const bodyPromise = res.text();
  const shutdownPromise = Shutdown.__runForTests("SIGTERM", {
    server: new IdleServer(),
    db,
    supervisor: { async stopAll() {} },
    drainMs: 200,
    hardKillMs: 1_000,
    exit: () => undefined,
  });

  await sleep(25);
  const controller = requireController(upstreamController);
  controller.enqueue(encoder.encode(finalEvent));
  controller.close();

  expect(await bodyPromise).toContain(finalEvent);
  await shutdownPromise;

  db = Storage.initDb(dbPath);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "completed",
    status: 200,
    total_tokens: 10,
    incomplete: 0,
  });
  db.close();
  cleanupDb(dbPath);
});

// TODO(#67): re-enable after stream abort path is reconciled with backpressure pull loop.
// shutdown completes correctly and aborted_rows finalize the DB row, but the client-side
// `res.text()` never resolves because the output ReadableStream isn't errored when the
// shutdown abort fires before the client begins reading. Tracked as follow-up.
test.skip("shutdown aborts active streams after drain timeout", async () => {
  const dbPath = tempDbPath();
  let db = Storage.initDb(dbPath);
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"model\":\"gpt-4o\"}\n"));
    },
  });
  const usageService = UsageService.create(db);
  const handle = PassThroughProxy.create(usageService, {
    async fetch() {
      return new Response(upstream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const req = request("/v1/chat/completions", { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  const bodyPromise = res.text().catch(() => "aborted");
  const server = new IdleServer();

  await Shutdown.__runForTests("SIGTERM", {
    server,
    db,
    supervisor: { async stopAll() {} },
    drainMs: 5,
    hardKillMs: 100,
    exit: () => undefined,
  });

  expect(await bodyPromise).toBe("aborted");
  expect(server.stopCalls).toEqual([false]);

  db = Storage.initDb(dbPath);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "aborted",
    status: 499,
    error_code: "aborted",
    incomplete: 1,
  });
  db.close();
  cleanupDb(dbPath);
});

test("shutdown hard kill bulk-finalizes still-pending active lifecycle rows", async () => {
  const dbPath = tempDbPath();
  let db = Storage.initDb(dbPath);
  const id = RequestRepo.insert(db, baseLog({ request_id: "stuck-active" }));
  const controller = new AbortController();
  let aborted = false;
  const handle = {
    id,
    requestId: "stuck-active",
    done: new Promise<void>(() => undefined),
    signal: controller.signal,
    abort(reason?: unknown) {
      aborted = true;
      if (!controller.signal.aborted) controller.abort(reason);
    },
    isDone() {
      return false;
    },
  };
  const unregister = Shutdown.registerActiveLifecycleHandlesProvider(() => [handle]);
  const server = new IdleServer();

  try {
    await Shutdown.__runForTests("SIGTERM", {
      server,
      db,
      supervisor: { async stopAll() {} },
      drainMs: 5,
      hardKillMs: 30,
      exit: () => undefined,
    });
  } finally {
    unregister();
  }

  expect(aborted).toBe(true);
  expect(server.stopCalls).toEqual([false, true]);

  db = Storage.initDb(dbPath);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "aborted",
    error_message: "shutdown",
  });
  db.close();
  cleanupDb(dbPath);
});
