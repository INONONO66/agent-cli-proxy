import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Storage } from "../../src/storage/db";
import { RequestRepo } from "../../src/storage/repo";
import type { Usage } from "../../src/usage";

const migration005 = new URL(
  "../../src/storage/migrations/005_lifecycle_cost_subscription.sql",
  import.meta.url,
);

function splitStatements(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

async function applyMigration005(db: Database): Promise<void> {
  const sql = await Bun.file(migration005).text();
  for (const stmt of splitStatements(sql)) db.exec(stmt);
}

function tableColumns(db: Database, table: string): Record<string, string> {
  const rows = db
    .query(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string; type: string }>;
  return Object.fromEntries(rows.map((row) => [row.name, row.type]));
}

function indexNames(db: Database, table: string): string[] {
  return (
    db.query(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function createOldRequestLogs(db: Database): void {
  db.exec(`
    CREATE TABLE request_logs (
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
      meta_json TEXT
    )
  `);
}

function baseLog(overrides: Partial<Omit<Usage.RequestLog, "id">> = {}): Omit<Usage.RequestLog, "id"> {
  return {
    request_id: "req-default",
    provider: "anthropic",
    model: "claude-sonnet",
    tool: "opencode",
    client_id: "local",
    path: "/v1/messages",
    streamed: 0,
    status: 200,
    prompt_tokens: 10,
    completion_tokens: 5,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 15,
    cost_usd: 0,
    incomplete: 0,
    started_at: "2026-05-04T10:00:00.000Z",
    finished_at: "2026-05-04T10:00:01.000Z",
    ...overrides,
  };
}

test("fresh DB has lifecycle/cost/subscription columns, cost_audit, and indexes", () => {
  const db = Storage.initDb(":memory:");
  const columns = tableColumns(db, "request_logs");

  expect(columns.status).toBe("INTEGER");
  expect(columns.lifecycle_status).toBe("TEXT");
  expect(columns.cost_status).toBe("TEXT");
  expect(columns.subscription_code).toBe("TEXT");
  expect(columns.finalized_at).toBe("TEXT");
  expect(columns.error_message).toBe("TEXT");

  const costAuditColumns = tableColumns(db, "cost_audit");
  expect(costAuditColumns.request_log_id).toBe("INTEGER");
  expect(costAuditColumns.base_cost_usd).toBe("REAL");
  expect(costAuditColumns.calc_at).toBe("TEXT");

  const requestIndexes = indexNames(db, "request_logs");
  expect(requestIndexes).toContain("idx_request_logs_lifecycle_status");
  expect(requestIndexes).toContain("idx_request_logs_cost_status");
  expect(requestIndexes).toContain("idx_request_logs_subscription_code");
  expect(indexNames(db, "cost_audit")).toContain("idx_cost_audit_request_log_id");

  const applied = db
    .query("SELECT name FROM schema_migrations WHERE name = ?")
    .get("005_lifecycle_cost_subscription.sql");
  expect(applied).toBeTruthy();
});

test("migration 005 upgrades old rows without data loss and backfills lifecycle/cost", async () => {
  const db = new Database(":memory:");
  createOldRequestLogs(db);
  db.query(`
    INSERT INTO request_logs (
      provider, model, tool, client_id, path, streamed, status,
      prompt_tokens, completion_tokens, cache_creation_tokens, cache_read_tokens,
      total_tokens, cost_usd, incomplete, error_code, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "anthropic", "claude", "opencode", "client-a", "/v1/messages", 0, 200,
    1, 2, 0, 0, 3, 0.25, 0, null, "2026-05-04T00:00:00.000Z", "2026-05-04T00:00:01.000Z",
  );
  db.query(`
    INSERT INTO request_logs (
      provider, model, tool, client_id, path, streamed, status,
      prompt_tokens, completion_tokens, cache_creation_tokens, cache_read_tokens,
      total_tokens, cost_usd, incomplete, error_code, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "openai", "gpt", "opencode", "client-b", "/v1/chat/completions", 0, 500,
    1, 2, 0, 0, 3, 0, 0, "upstream_error", "2026-05-04T01:00:00.000Z", null,
  );

  await applyMigration005(db);

  const rows = db
    .query(`
      SELECT id, provider, status, lifecycle_status, cost_status, finalized_at, cost_usd, error_code
      FROM request_logs ORDER BY id
    `)
    .all() as Usage.RequestLog[];

  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    provider: "anthropic",
    status: 200,
    lifecycle_status: "completed",
    cost_status: "ok",
    finalized_at: "2026-05-04T00:00:01.000Z",
    cost_usd: 0.25,
  });
  expect(rows[1]).toMatchObject({
    provider: "openai",
    status: 500,
    lifecycle_status: "error",
    cost_status: "pending",
    finalized_at: "2026-05-04T01:00:00.000Z",
    error_code: "upstream_error",
  });
});

test("RequestRepo.insert derives lifecycle/cost defaults and keeps HTTP status correlation", () => {
  const db = Storage.initDb(":memory:");
  const successId = RequestRepo.insert(db, baseLog({ request_id: "success", cost_usd: 0.1 }));
  const errorId = RequestRepo.insert(db, baseLog({
    request_id: "error",
    status: 503,
    cost_usd: 0,
    error_code: "bad_gateway",
    finished_at: undefined,
  }));

  expect(RequestRepo.getById(db, successId)).toMatchObject({
    status: 200,
    lifecycle_status: "completed",
    cost_status: "ok",
    finalized_at: "2026-05-04T10:00:01.000Z",
  });
  expect(RequestRepo.getById(db, errorId)).toMatchObject({
    status: 503,
    lifecycle_status: "error",
    cost_status: "pending",
    finalized_at: "2026-05-04T10:00:00.000Z",
  });

  const uncorrelated = RequestRepo.getUncorrelated(db, 10_000_000_000, 10);
  expect(uncorrelated.map((row) => row.id)).toEqual([successId]);
  expect(uncorrelated[0]?.status).toBe(200);
});

test("RequestRepo lifecycle updates and cost audit inserts are available", () => {
  const db = Storage.initDb(":memory:");
  const id = RequestRepo.insert(db, baseLog({ request_id: "audit", lifecycle_status: "pending", finished_at: undefined }));

  RequestRepo.updateLifecycle(db, id, {
    lifecycle_status: "aborted",
    finalized_at: "2026-05-04T10:00:02.000Z",
    error_message: "client disconnected",
    cost_status: "unsupported",
    subscription_code: "pro-weekly",
  });
  const auditId = RequestRepo.insertCostAudit(db, {
    request_log_id: id,
    model: "claude-sonnet",
    provider: "anthropic",
    source: "unit-test",
    base_cost_usd: 0.123,
    calc_at: "2026-05-04T10:00:03.000Z",
  });

  expect(RequestRepo.getById(db, id)).toMatchObject({
    lifecycle_status: "aborted",
    finalized_at: "2026-05-04T10:00:02.000Z",
    error_message: "client disconnected",
    cost_status: "unsupported",
    subscription_code: "pro-weekly",
  });
  expect(db.query("SELECT * FROM cost_audit WHERE id = ?").get(auditId)).toMatchObject({
    request_log_id: id,
    model: "claude-sonnet",
    provider: "anthropic",
    source: "unit-test",
    base_cost_usd: 0.123,
    calc_at: "2026-05-04T10:00:03.000Z",
  });
});
