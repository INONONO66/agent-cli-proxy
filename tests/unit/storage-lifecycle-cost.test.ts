import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Storage } from "../../src/storage/db";
import { RequestRepo } from "../../src/storage/repo";
import { UsageService } from "../../src/storage/service";
import { Pricing } from "../../src/storage/pricing";
import type { Usage } from "../../src/usage";

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

test("fresh DB has lifecycle/cost columns, cost_audit, and indexes", () => {
  const db = Storage.initDb(":memory:");
  const columns = tableColumns(db, "request_logs");

  expect(columns.status).toBe("INTEGER");
  expect(columns.lifecycle_status).toBe("TEXT");
  expect(columns.cost_status).toBe("TEXT");
  expect(columns.finalized_at).toBe("TEXT");
  expect(columns.error_message).toBe("TEXT");
  expect(columns.actual_model).toBe("TEXT");
  expect(columns.actual_provider).toBe("TEXT");

  const costAuditColumns = tableColumns(db, "cost_audit");
  expect(costAuditColumns.request_log_id).toBe("INTEGER");
  expect(costAuditColumns.base_cost_usd).toBe("REAL");
  expect(costAuditColumns.calc_at).toBe("TEXT");

  const requestIndexes = indexNames(db, "request_logs");
  expect(requestIndexes).toContain("idx_request_logs_lifecycle_status");
  expect(requestIndexes).toContain("idx_request_logs_cost_status");
  expect(indexNames(db, "cost_audit")).toContain("idx_cost_audit_request_log_id");

  const applied = db
    .query("SELECT name FROM schema_migrations WHERE name = ?")
    .get("001_init.sql");
  expect(applied).toBeTruthy();
});



test("RequestRepo.insert derives lifecycle/cost defaults and keeps HTTP status correlation", () => {
  const db = Storage.initDb(":memory:");
  const now = Date.now();
  const startedAt = new Date(now).toISOString();
  const finishedAt = new Date(now + 1_000).toISOString();
  const successId = RequestRepo.insert(db, baseLog({
    request_id: "success",
    cost_usd: 0.1,
    started_at: startedAt,
    finished_at: finishedAt,
  }));
  const errorId = RequestRepo.insert(db, baseLog({
    request_id: "error",
    status: 503,
    cost_usd: 0,
    error_code: "bad_gateway",
    started_at: startedAt,
    finished_at: undefined,
  }));

  expect(RequestRepo.getById(db, successId)).toMatchObject({
    status: 200,
    lifecycle_status: "completed",
    cost_status: "ok",
    finalized_at: finishedAt,
  });
  expect(RequestRepo.getById(db, errorId)).toMatchObject({
    status: 503,
    lifecycle_status: "error",
    cost_status: "pending",
    finalized_at: startedAt,
  });

  const uncorrelated = RequestRepo.getUncorrelated(db, 60_000, 10);
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

test("RequestRepo finalization does not regress token counters with smaller retry usage", () => {
  const db = Storage.initDb(":memory:");
  const id = RequestRepo.insert(db, baseLog({
    request_id: "regression-guard",
    lifecycle_status: "pending",
    status: undefined,
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_creation_tokens: 10,
    cache_read_tokens: 20,
    total_tokens: 180,
    finished_at: undefined,
  }));

  const updated = RequestRepo.updateFinalize(db, id, {
    status: 200,
    prompt_tokens: 10,
    completion_tokens: 5,
    cache_creation_tokens: 1,
    cache_read_tokens: 2,
    reasoning_tokens: 0,
    total_tokens: 18,
    cost_usd: 0.1,
    incomplete: 0,
    lifecycle_status: "completed",
    finalized_at: "2026-05-04T10:00:02.000Z",
    cost_status: "ok",
  });

  expect(updated).toBe(1);
  expect(RequestRepo.getById(db, id)).toMatchObject({
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_creation_tokens: 10,
    cache_read_tokens: 20,
    total_tokens: 180,
  });
});

test("UsageService finalization computes daily usage from non-regressed token counters", async () => {
  Pricing.__setPricingForTests([["anthropic/claude-sonnet", { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 }]]);
  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);
  const id = RequestRepo.insert(db, baseLog({
    request_id: "daily-regression-guard",
    lifecycle_status: "pending",
    status: undefined,
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_creation_tokens: 10,
    cache_read_tokens: 20,
    total_tokens: 180,
    finished_at: undefined,
  }));

  const finalized = await service.finalizeUsage(id, baseLog({
    request_id: "daily-regression-guard",
    status: 200,
    lifecycle_status: "completed",
    prompt_tokens: 10,
    completion_tokens: 5,
    cache_creation_tokens: 1,
    cache_read_tokens: 2,
    total_tokens: 18,
    cost_usd: 0,
    finished_at: "2026-05-04T10:00:02.000Z",
    finalized_at: "2026-05-04T10:00:02.000Z",
  }));

  const daily = db.query("SELECT * FROM daily_usage").get() as Usage.DailyUsage;
  expect(finalized).toBe(true);
  expect(daily).toMatchObject({
    request_count: 1,
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_creation_tokens: 10,
    cache_read_tokens: 20,
    total_tokens: 180,
  });
  expect(daily.cost_usd).toBeCloseTo(0.0002145);
});
