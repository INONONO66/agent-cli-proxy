import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RequestInfo } from "../../src/server/request-inspector";
import type { UpstreamClient } from "../../src/upstream/client";
import type { Usage } from "../../src/usage";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";

const { RequestInspector } = await import("../../src/server/request-inspector");
const { PassThroughProxy } = await import("../../src/server/pass-through");
const { Storage } = await import("../../src/storage/db");
const { UsageService } = await import("../../src/storage/service");
const { RequestRepo } = await import("../../src/storage/repo");
const { Pricing } = await import("../../src/storage/pricing");

const encoder = new TextEncoder();
const price = { input: 1, output: 1, cache_read: 1, cache_write: 1, reasoning: 1 };
type TestUsageService = ReturnType<typeof UsageService.create>;

beforeEach(() => {
  Pricing.__setPricingForTests([
    ["openai/gpt-5.4-mini", price],
    ["gpt-5.4-mini", price],
    ["openai/gpt-4o", price],
    ["gpt-4o", price],
    ["anthropic/claude-sonnet-4-20250514", price],
    ["claude-sonnet-4-20250514", price],
  ]);
});

afterEach(() => {
  Pricing.__setPricingForTests([
    ["openai/gpt-5.4-mini", price],
    ["gpt-5.4-mini", price],
  ]);
});

type FetchUpstream = (options: UpstreamClient.FetchOptions) => Promise<Response>;

function createHarness(fetch: FetchUpstream) {
  const db = Storage.initDb(":memory:");
  const usageService = UsageService.create(db);
  const handle = PassThroughProxy.create(usageService, { fetch });
  return { db, usageService, handle };
}

function createHarnessWithService(fetch: FetchUpstream, usageService: TestUsageService) {
  const handle = PassThroughProxy.create(usageService, { fetch });
  return { handle };
}

function request(path: string, body: Record<string, unknown>, headers: HeadersInit = {}): Request {
  return new Request(`http://proxy.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "opencode/1.0", ...headers },
    body: JSON.stringify(body),
  });
}

async function inspect(req: Request): Promise<RequestInfo> {
  return RequestInspector.inspect(req);
}

function latest(db: Database): Usage.RequestLog {
  return db.query("SELECT * FROM request_logs ORDER BY id DESC LIMIT 1").get() as Usage.RequestLog;
}

function allLogs(db: Database): Usage.RequestLog[] {
  return db.query("SELECT * FROM request_logs ORDER BY id ASC").all() as Usage.RequestLog[];
}

function isMsgIdIndexUnique(db: Database): boolean {
  const indexes = db.query("PRAGMA index_list(request_logs)").all() as Array<{ name: string; unique: number }>;
  const msgIdIndex = indexes.find((index) => index.name === "idx_request_logs_msg_id");
  return msgIdIndex?.unique === 1;
}

test("pre-log row exists immediately after request entry", async () => {
  const capturedRows: Usage.RequestLog[] = [];
  const { db, handle } = createHarness(async () => {
    capturedRows.push(latest(db));
    return new Response(JSON.stringify({ model: "gpt-5.4-mini", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const req = request("/v1/chat/completions", { model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  await res.text();

  const rowDuringFetch = capturedRows[0];
  expect(rowDuringFetch).toMatchObject({
    lifecycle_status: "pending",
    cost_status: "unresolved",
    model: "gpt-5.4-mini",
    tool: "opencode",
    path: "/v1/chat/completions",
  });
  expect(rowDuringFetch?.request_id).toBeString();
  expect(allLogs(db)).toHaveLength(1);
});

test("successful request finalizes one row as completed with priced usage", async () => {
  const { db, handle } = createHarness(async () => new Response(JSON.stringify({
    model: "gpt-5.4-mini",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } }));

  const req = request("/v1/chat/completions", { model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  await res.text();

  expect(allLogs(db)).toHaveLength(1);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "completed",
    cost_status: "ok",
    status: 200,
    total_tokens: 15,
    incomplete: 0,
  });
  expect(latest(db).cost_usd).toBeGreaterThan(0);
  expect(latest(db).finalized_at).toBeString();
});

test("duplicate external x-request-id values keep distinct proxy request ids", async () => {
  const { db, handle } = createHarness(async () => new Response(JSON.stringify({
    model: "gpt-5.4-mini",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const headers = { "x-request-id": "external-msg-id" };

  const first = request("/v1/chat/completions", { model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] }, headers);
  const second = request("/v1/chat/completions", { model: "gpt-5.4-mini", messages: [{ role: "user", content: "again" }] }, headers);
  await (await handle(first, await inspect(first))).text();
  await (await handle(second, await inspect(second))).text();

  const rows = allLogs(db);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.msg_id)).toEqual(["external-msg-id", "external-msg-id"]);
  expect(rows[0]?.request_id).toBeString();
  expect(rows[1]?.request_id).toBeString();
  expect(rows[0]?.request_id).not.toBe(rows[1]?.request_id);
});

test("upstream 502 finalizes the pre-log row as error", async () => {
  const { db, handle } = createHarness(async () => new Response(JSON.stringify({ error: "bad gateway" }), {
    status: 502,
    headers: { "content-type": "application/json" },
  }));

  const req = request("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  await res.text();

  expect(allLogs(db)).toHaveLength(1);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "error",
    status: 502,
    error_code: "upstream_error",
    incomplete: 1,
  });
  expect(latest(db).error_message).toContain("upstream HTTP 502");
});

test("transient finalize failures are retried before completing the row", async () => {
  const db = Storage.initDb(":memory:");
  const usageService = UsageService.create(db);
  let attempts = 0;
  const retryingService: TestUsageService = {
    ...usageService,
    async finalizeUsage(id, log) {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary finalize write failure");
      return usageService.finalizeUsage(id, log);
    },
  };
  const { handle } = createHarnessWithService(async () => new Response(JSON.stringify({
    model: "gpt-5.4-mini",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } }), retryingService);

  const req = request("/v1/chat/completions", { model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  await res.text();

  expect(attempts).toBe(3);
  expect(allLogs(db)).toHaveLength(1);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "completed",
    status: 200,
    total_tokens: 15,
    incomplete: 0,
  });
});

test("exhausted finalize retries mark the pending row as error", async () => {
  const db = Storage.initDb(":memory:");
  const usageService = UsageService.create(db);
  let attempts = 0;
  const failingService: TestUsageService = {
    ...usageService,
    async finalizeUsage() {
      attempts += 1;
      throw new Error("database locked");
    },
  };
  const { handle } = createHarnessWithService(async () => new Response(JSON.stringify({
    model: "gpt-5.4-mini",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } }), failingService);

  const req = request("/v1/chat/completions", { model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  await res.text();

  expect(attempts).toBe(3);
  expect(allLogs(db)).toHaveLength(1);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "error",
    cost_status: "pending",
    error_code: "finalize_failed",
    incomplete: 1,
  });
  expect(latest(db).error_message).toContain("finalize_failed");
  expect(latest(db).finalized_at).toBeString();
});

test("client abort during streaming finalizes one row as aborted", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } })}\n`));
    },
  });
  const { db, handle } = createHarness(async () => new Response(upstream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }));

  const req = request("/v1/chat/completions", { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  const reader = res.body?.getReader();
  expect(reader).toBeDefined();
  await reader?.read();
  await reader?.cancel("unit-test abort");

  expect(allLogs(db)).toHaveLength(1);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "aborted",
    status: 499,
    error_code: "aborted",
    incomplete: 1,
  });
  expect(latest(db).error_message).toContain("unit-test abort");
});

test("boot recovery aborts stale pending rows", () => {
  const dbPath = join(tmpdir(), `agent-cli-proxy-lifecycle-${crypto.randomUUID()}.db`);
  const db = Storage.initDb(dbPath);
  RequestRepo.insert(db, {
    request_id: "stale-pending",
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
    started_at: new Date(Date.now() - 60_000).toISOString(),
    lifecycle_status: "pending",
    cost_status: "unresolved",
  });
  db.close();

  const restarted = Storage.initDb(dbPath);
  expect(Storage.recoverStalePending(restarted, 1_000)).toBe(1);
  const row = latest(restarted);
  expect(row).toMatchObject({
    lifecycle_status: "aborted",
    error_message: "boot-recovery",
    cost_status: "pending",
    incomplete: 1,
  });
  expect(row.finalized_at).toBeString();
  restarted.close();
  unlinkSync(dbPath);
});

test("migration replaces legacy unique msg_id index with non-unique lookup index", () => {
  const dbPath = join(tmpdir(), `agent-cli-proxy-msg-id-${crypto.randomUUID()}.db`);
  const legacy = new Database(dbPath);
  for (const statement of legacySchemaStatements) legacy.query(statement).run();
  expect(isMsgIdIndexUnique(legacy)).toBe(true);
  legacy.close();

  const migrated = Storage.initDb(dbPath);
  expect(isMsgIdIndexUnique(migrated)).toBe(false);
  const firstId = RequestRepo.insert(migrated, baseLogForDuplicateMsgId("proxy-req-1"));
  const secondId = RequestRepo.insert(migrated, baseLogForDuplicateMsgId("proxy-req-2"));

  expect(firstId).not.toBe(secondId);
  expect(allLogs(migrated).map((row) => row.request_id)).toEqual(["proxy-req-1", "proxy-req-2"]);
  expect(allLogs(migrated).map((row) => row.msg_id)).toEqual(["external-msg-id", "external-msg-id"]);
  migrated.close();
  unlinkSync(dbPath);
});

const legacySchemaStatements = [
  `CREATE TABLE schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    tool TEXT DEFAULT 'unknown',
    client_id TEXT DEFAULT 'unknown',
    path TEXT NOT NULL,
    streamed INTEGER NOT NULL DEFAULT 0,
    status INTEGER,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    incomplete INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    latency_ms INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    meta_json TEXT,
    msg_id TEXT
  )`,
  "CREATE UNIQUE INDEX idx_request_logs_msg_id ON request_logs(msg_id) WHERE msg_id IS NOT NULL",
  `INSERT INTO schema_migrations (name) VALUES
    ('001_init.sql'),
    ('002_agent_attribution.sql'),
    ('003_enhanced_logging.sql'),
    ('004_cliproxy_attribution.sql'),
    ('005_lifecycle_cost_subscription.sql'),
    ('006_account_subscriptions.sql')`,
];

function baseLogForDuplicateMsgId(requestId: string): Omit<Usage.RequestLog, "id"> {
  return {
    request_id: requestId,
    provider: "openai",
    model: "gpt-4o",
    tool: "opencode",
    client_id: "opencode-test",
    path: "/v1/chat/completions",
    streamed: 0,
    status: 200,
    prompt_tokens: 1,
    completion_tokens: 1,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 2,
    cost_usd: 0,
    incomplete: 0,
    started_at: "2026-05-04T10:00:00.000Z",
    finished_at: "2026-05-04T10:00:01.000Z",
    msg_id: "external-msg-id",
  };
}

test("Anthropic body rewrite strips stale transfer headers before upstream fetch", async () => {
  let forwardedHeaders = new Headers();
  const { handle } = createHarness(async (options) => {
    forwardedHeaders = new Headers(options.headers);
    return new Response(JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const req = request("/v1/messages", {
    model: "claude-sonnet-4-20250514",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
  }, {
    "content-length": "999",
    "content-encoding": "gzip",
    "accept-encoding": "gzip",
  });
  const res = await handle(req, await inspect(req));
  await res.text();

  expect(forwardedHeaders.get("content-length")).toBeNull();
  expect(forwardedHeaders.get("content-encoding")).toBeNull();
  expect(forwardedHeaders.get("accept-encoding")).toBeNull();
  expect(forwardedHeaders.get("content-type")).toBe("application/json");
});

test("stream flush forwards final SSE line without trailing newline and finalizes usage once", async () => {
  const finalEvent = `data: ${JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}`;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(finalEvent));
      controller.close();
    },
  });
  const { db, handle } = createHarness(async () => new Response(upstream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }));

  const req = request("/v1/chat/completions", { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  const text = await res.text();

  expect(text).toContain(finalEvent);
  expect(allLogs(db)).toHaveLength(1);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "completed",
    status: 200,
    total_tokens: 15,
    prompt_tokens: 10,
    completion_tokens: 5,
  });
});

test("stream relay does not eagerly drain upstream before downstream reads", async () => {
  const labels = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
  const events = labels.map((label, index) => ({
    model: index === 0 ? "gpt-4o" : undefined,
    choices: [{ delta: { content: label }, index: 0 }],
    usage: index === labels.length - 1 ? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } : undefined,
  }));
  const chunks = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  let upstreamPulls = 0;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[upstreamPulls];
      upstreamPulls += 1;
      if (chunk) controller.enqueue(encoder.encode(chunk));
      if (upstreamPulls === chunks.length) controller.close();
    },
  });
  const { db, handle } = createHarness(async () => new Response(upstream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }));

  const req = request("/v1/chat/completions", { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));

  expect(upstreamPulls).toBeLessThan(chunks.length);

  const reader = res.body?.getReader();

  expect(reader).toBeDefined();
  expect(upstreamPulls).toBeLessThan(chunks.length);

  const first = await reader?.read();
  expect(first?.done).toBe(false);
  expect(upstreamPulls).toBeLessThan(chunks.length);

  let text = first?.value ? new TextDecoder().decode(first.value) : "";
  while (true) {
    const next = await reader?.read();
    if (next?.done) break;
    if (next?.value) text += new TextDecoder().decode(next.value);
  }

  expect(text.indexOf("one")).toBeLessThan(text.indexOf("two"));
  expect(text.indexOf("seven")).toBeLessThan(text.indexOf("eight"));
  expect(upstreamPulls).toBe(chunks.length);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "completed",
    status: 200,
    total_tokens: 15,
  });
});
