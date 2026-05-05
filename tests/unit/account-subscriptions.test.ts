import { expect, test } from "bun:test";
import { Storage } from "../../src/storage/db";
import { AccountSubscriptionRepo } from "../../src/storage/account-subscriptions";
import { RequestRepo } from "../../src/storage/repo";
import { Plans } from "../../src/plans";
import type { Logger } from "../../src/util/logger";
import type { Usage } from "../../src/usage";

function baseLog(overrides: Partial<Omit<Usage.RequestLog, "id">> = {}): Omit<Usage.RequestLog, "id"> {
  return {
    request_id: "req-account-subscription",
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
    reasoning_tokens: 0,
    total_tokens: 15,
    cost_usd: 0,
    incomplete: 0,
    started_at: "2026-05-05T10:00:00.000Z",
    finished_at: "2026-05-05T10:00:01.000Z",
    ...overrides,
  };
}

function createLoggerSink(lines: string[]): Logger.Logger {
  return {
    child() {
      return this;
    },
    debug(msg, fields) {
      lines.push(JSON.stringify({ level: "debug", msg, ...fields }));
    },
    info(msg, fields) {
      lines.push(JSON.stringify({ level: "info", msg, ...fields }));
    },
    warn(msg, fields) {
      lines.push(JSON.stringify({ level: "warn", msg, ...fields }));
    },
    error(msg, fields) {
      lines.push(JSON.stringify({ level: "error", msg, ...fields }));
    },
  };
}

test("migration creates account_subscriptions table and index", () => {
  const db = Storage.initDb(":memory:");

  const columns = db.query("PRAGMA table_info(account_subscriptions)").all() as Array<{ name: string }>;
  expect(columns.map((column) => column.name)).toEqual([
    "cliproxy_account",
    "subscription_code",
    "bound_at",
  ]);

  const indexes = db.query("PRAGMA index_list(account_subscriptions)").all() as Array<{ name: string }>;
  expect(indexes.map((index) => index.name)).toContain("idx_account_subscriptions_subscription_code");
  expect(
    db.query("SELECT name FROM schema_migrations WHERE name = ?")
      .get("006_account_subscriptions.sql"),
  ).toBeTruthy();
});

test("bind, unbind, get, and list round-trip", () => {
  const db = Storage.initDb(":memory:");

  AccountSubscriptionRepo.bind(db, "acc1", "claude_pro");

  expect(AccountSubscriptionRepo.get(db, "acc1")).toMatchObject({
    cliproxy_account: "acc1",
    subscription_code: "claude_pro",
  });
  expect(AccountSubscriptionRepo.list(db)).toHaveLength(1);

  AccountSubscriptionRepo.unbind(db, "acc1");

  expect(AccountSubscriptionRepo.get(db, "acc1")).toBeNull();
  expect(AccountSubscriptionRepo.list(db)).toEqual([]);
});

test("plan binding input validates account and code", () => {
  expect(Plans.validateBindingInput(" acc1 ", " claude_pro ")).toEqual({
    account: "acc1",
    code: "claude_pro",
  });
  expect(() => Plans.validateBindingInput("", "claude_pro")).toThrow("Account must be a non-empty string");
  expect(() => Plans.validateBindingInput("acc1", "nonexistent_code")).toThrow("Unknown plan code: nonexistent_code");
});

test("rebinding the same account replaces the previous subscription code", () => {
  const db = Storage.initDb(":memory:");

  AccountSubscriptionRepo.bind(db, "acc1", "claude_pro");
  AccountSubscriptionRepo.bind(db, "acc1", "chatgpt_plus");

  expect(AccountSubscriptionRepo.list(db)).toHaveLength(1);
  expect(AccountSubscriptionRepo.get(db, "acc1")).toMatchObject({
    cliproxy_account: "acc1",
    subscription_code: "chatgpt_plus",
  });
});

async function loadUsageService() {
  process.env.PROXY_LOCAL_OK = "1";
  return await import("../../src/storage/service");
}

test("correlation applies subscription_code from account binding", async () => {
  const { UsageService } = await loadUsageService();
  const db = Storage.initDb(":memory:");
  const service = UsageService.create(db);
  const id = RequestRepo.insert(db, baseLog({ lifecycle_status: "pending", finished_at: undefined }));
  AccountSubscriptionRepo.bind(db, "acc-bound", "claude_pro");

  service.applyCorrelation(id, RequestRepo.getById(db, id)!, {
    cliproxy_account: "acc-bound",
    cliproxy_auth_index: "0",
    cliproxy_source: "acc-bound",
    reasoning_tokens: 3,
    actual_model: "claude-sonnet",
  });

  expect(RequestRepo.getById(db, id)).toMatchObject({
    cliproxy_account: "acc-bound",
    subscription_code: "claude_pro",
  });
});

test("unmapped subscription warning logs once per account and day", async () => {
  const { UsageService } = await loadUsageService();
  const db = Storage.initDb(":memory:");
  const lines: string[] = [];
  const service = UsageService.create(db, {
    logger: createLoggerSink(lines),
    now: () => new Date("2026-05-05T12:00:00.000Z"),
  });
  const firstId = RequestRepo.insert(db, baseLog({ request_id: "unmapped-1", lifecycle_status: "pending", finished_at: undefined }));
  const secondId = RequestRepo.insert(db, baseLog({ request_id: "unmapped-2", lifecycle_status: "pending", finished_at: undefined }));

  service.applyCorrelation(firstId, RequestRepo.getById(db, firstId)!, {
    cliproxy_account: "acc-unmapped-t10",
  });
  service.applyCorrelation(secondId, RequestRepo.getById(db, secondId)!, {
    cliproxy_account: "acc-unmapped-t10",
  });

  const warnings = lines.map((line) => JSON.parse(line) as { event?: string })
    .filter((line) => line.event === "plans.unmapped");
  expect(warnings).toHaveLength(1);
});
