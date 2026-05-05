import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Usage } from "../../src/usage";

type StorageModule = typeof import("../../src/storage/db");
type ServiceModule = typeof import("../../src/storage/service");
type HandlerModule = typeof import("../../src/server/handler");
type RepoModule = typeof import("../../src/storage/repo");
type SubscriptionModule = typeof import("../../src/storage/account-subscriptions");

const ADMIN_TOKEN = "plans-admin-token";

let storageModule: StorageModule;
let serviceModule: ServiceModule;
let handlerModule: HandlerModule;
let repoModule: RepoModule;
let subscriptionModule: SubscriptionModule;
let db: Database;
let handleRequest: (req: Request) => Promise<Response>;

describe("Admin plan endpoints", () => {
  beforeAll(async () => {
    process.env.PROXY_LOCAL_OK = "1";
    process.env.PROXY_HOST = "0.0.0.0";
    process.env.ADMIN_API_KEY = ADMIN_TOKEN;

    storageModule = await import("../../src/storage/db");
    serviceModule = await import("../../src/storage/service");
    handlerModule = await import("../../src/server/handler");
    repoModule = await import("../../src/storage/repo");
    subscriptionModule = await import("../../src/storage/account-subscriptions");
  });

  beforeEach(() => {
    db = storageModule.Storage.initDb(":memory:");
    const service = serviceModule.UsageService.create(db);
    handleRequest = handlerModule.Handler.create(service);
  });

  it("GET /admin/plans returns loaded plan fields", async () => {
    const res = await adminGet("/admin/plans");

    expect(res.status).toBe(200);
    const body = await res.json() as { plans: Array<Record<string, unknown>> };
    const claudePro = body.plans.find((plan) => plan.code === "claude_pro");
    expect(claudePro).toMatchObject({
      code: "claude_pro",
      provider: "anthropic",
      monthly_price_usd: 20,
      currency: "USD",
      billing_period_days: 30,
    });
    expect(typeof claudePro?.display_name).toBe("string");
    expect(typeof claudePro?.vendor_url).toBe("string");
    expect(typeof claudePro?.notes).toBe("string");
  });

  it("GET /admin/plans/cost-summary aggregates bound and unbound completed monthly usage", async () => {
    subscriptionModule.AccountSubscriptionRepo.bind(db, "acc1", "claude_pro");
    insertLog("acc1", { request_id: "t13-acc1-a", cost_usd: 15, started_at: "2026-05-05T10:00:00.000Z" });
    insertLog("acc1", { request_id: "t13-acc1-b", cost_usd: 8, started_at: "2026-05-20T10:00:00.000Z" });
    insertLog("acc2", { request_id: "t13-acc2", cost_usd: 2, started_at: "2026-05-06T10:00:00.000Z" });
    insertLog("acc1", { request_id: "t13-outside", cost_usd: 100, started_at: "2026-06-01T00:00:00.000Z" });
    insertLog("acc1", {
      request_id: "t13-error",
      cost_usd: 100,
      status: 500,
      lifecycle_status: "error",
      started_at: "2026-05-07T10:00:00.000Z",
    });

    const res = await adminGet("/admin/plans/cost-summary?month=2026-05");

    expect(res.status).toBe(200);
    const body = await res.json() as CostSummaryBody;
    const boundRow = body.rows.find((row) => row.cliproxy_account === "acc1");
    expect(boundRow).toMatchObject({
      cliproxy_account: "acc1",
      subscription_code: "claude_pro",
      monthly_price_usd: 20,
      total_requests: 2,
    });
    expect(boundRow?.total_cost_usd).toBeCloseTo(23);
    expect(boundRow?.computed_overage_usd).toBeCloseTo(3);

    const unboundRow = body.rows.find((row) => row.cliproxy_account === "acc2");
    expect(unboundRow).toMatchObject({
      cliproxy_account: "acc2",
      subscription_code: null,
      monthly_price_usd: 0,
      total_requests: 1,
    });
    expect(unboundRow?.computed_overage_usd).toBeCloseTo(2);
    expect(body.totals).toMatchObject({
      accounts: 2,
      total_requests: 3,
      total_monthly_price_usd: 20,
    });
    expect(body.totals.total_cost_usd).toBeCloseTo(25);
    expect(body.totals.total_overage_usd).toBeCloseTo(5);
  });

  it("GET /admin/plans/cost-summary?month=invalid returns a structured 400", async () => {
    const res = await adminGet("/admin/plans/cost-summary?month=invalid");

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({
      code: "INVALID_MONTH",
      message: "month must use YYYY-MM format",
    });
  });

  it("GET /admin/plans/account/:account returns 404 when no binding or logs exist", async () => {
    const res = await adminGet("/admin/plans/account/missing-account");

    expect(res.status).toBe(404);
  });

  it("GET /admin/plans/account/:account returns binding and last 50 usage rows", async () => {
    subscriptionModule.AccountSubscriptionRepo.bind(db, "acc1", "claude_pro");
    for (let index = 0; index < 55; index += 1) {
      insertLog("acc1", {
        request_id: `t13-account-${index}`,
        model: `model-${index}`,
        total_tokens: index,
        cost_usd: index / 100,
        started_at: `2026-05-${String((index % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
      });
    }

    const res = await adminGet("/admin/plans/account/acc1");

    expect(res.status).toBe(200);
    const body = await res.json() as AccountViewBody;
    expect(body).toMatchObject({
      cliproxy_account: "acc1",
      subscription_code: "claude_pro",
      monthly_price_usd: 20,
    });
    expect(typeof body.bound_at).toBe("string");
    expect(body.recent_usage).toHaveLength(50);
    expect(body.recent_usage[0]).toMatchObject({
      lifecycle_status: "completed",
    });
  });

  it("admin plan routes require ADMIN_API_KEY when proxy host is not loopback", async () => {
    const script = `
      process.env.PROXY_LOCAL_OK = "1";
      process.env.PROXY_HOST = "0.0.0.0";
      process.env.ADMIN_API_KEY = "${ADMIN_TOKEN}";
      const { Storage } = await import("./src/storage/db.ts");
      const { UsageService } = await import("./src/storage/service.ts");
      const { Handler } = await import("./src/server/handler.ts");
      const db = Storage.initDb(":memory:");
      const handle = Handler.create(UsageService.create(db));
      const forbidden = await handle(new Request("http://127.0.0.1:3100/admin/plans"));
      const allowed = await handle(new Request("http://127.0.0.1:3100/admin/plans", { headers: { "x-admin-token": "${ADMIN_TOKEN}" } }));
      if (forbidden.status !== 403 || allowed.status !== 200) {
        throw new Error(\`unexpected statuses forbidden=\${forbidden.status} allowed=\${allowed.status}\`);
      }
    `;
    const proc = Bun.spawn(["bun", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, PROXY_HOST: "0.0.0.0", ADMIN_API_KEY: ADMIN_TOKEN, PROXY_LOCAL_OK: "1", PLANS_JSON: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    if (exitCode !== 0) throw new Error(stderrText);
    expect(exitCode).toBe(0);
  });
});

function adminGet(path: string, token: string | null = ADMIN_TOKEN): Promise<Response> {
  const headers = token ? { "x-admin-token": token } : undefined;
  return handleRequest(new Request(`http://127.0.0.1:3100${path}`, { headers }));
}

function insertLog(
  cliproxyAccount: string,
  overrides: Partial<Omit<Usage.RequestLog, "id">> = {},
): number {
  const id = repoModule.RequestRepo.insert(db, baseLog(overrides));
  repoModule.RequestRepo.applyCorrelation(db, id, { cliproxy_account: cliproxyAccount });
  return id;
}

function baseLog(overrides: Partial<Omit<Usage.RequestLog, "id">> = {}): Omit<Usage.RequestLog, "id"> {
  return {
    request_id: "t13-base-log",
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
    cost_usd: 1,
    incomplete: 0,
    started_at: "2026-05-05T10:00:00.000Z",
    finished_at: "2026-05-05T10:00:01.000Z",
    lifecycle_status: "completed",
    ...overrides,
  };
}

interface CostSummaryBody {
  rows: Array<{
    cliproxy_account: string;
    subscription_code: string | null;
    monthly_price_usd: number;
    total_requests: number;
    total_cost_usd: number;
    computed_overage_usd: number;
  }>;
  totals: {
    accounts: number;
    total_requests: number;
    total_cost_usd: number;
    total_monthly_price_usd: number;
    total_overage_usd: number;
  };
}

interface AccountViewBody {
  cliproxy_account: string;
  subscription_code: string | null;
  monthly_price_usd: number;
  bound_at: string | null;
  recent_usage: Array<{
    started_at: string;
    model: string;
    total_tokens: number;
    cost_usd: number;
    lifecycle_status: Usage.LifecycleStatus;
  }>;
}
