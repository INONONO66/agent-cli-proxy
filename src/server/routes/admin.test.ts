import { describe, test, expect, mock } from "bun:test";
import { createAdminRouter } from "./admin";
import type { UsageService } from "../../services/usageService";

const today = new Date().toISOString().slice(0, 10);

const mockUsageService: UsageService = {
  recordUsage: mock(() => 1),
  getToday: mock(() => ({
    date: today,
    requests: 5,
    total_tokens: 1000,
    cost_usd: 0.01,
    breakdown: [],
  })),
  getDateRange: mock(() => [
    { date: "2026-04-01", requests: 2, total_tokens: 500, cost_usd: 0.005, breakdown: [] },
    { date: "2026-04-02", requests: 3, total_tokens: 600, cost_usd: 0.006, breakdown: [] },
  ]),
  getModelBreakdown: mock(() => []),
  getProviderBreakdown: mock(() => []),
  getTotalStats: mock(() => ({
    total_requests: 100,
    total_tokens: 50000,
    total_cost_usd: 1.5,
    first_request_at: "2026-04-01T00:00:00Z",
    last_request_at: "2026-04-19T23:59:59Z",
  })),
  getRecentLogs: mock(() => []),
  getLogById: mock(() => null),
};

const adminRouter = createAdminRouter(mockUsageService);

function makeReq(path: string, method = "GET"): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("admin router", () => {
  test("GET /admin/usage/today → 200 with date field", async () => {
    const res = await adminRouter(makeReq("/admin/usage/today"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toHaveProperty("date", today);
    expect(body).toHaveProperty("requests");
  });

  test("GET /admin/usage/range?from&to → 200 array", async () => {
    const res = await adminRouter(
      makeReq("/admin/usage/range?from=2026-04-01&to=2026-04-19")
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /admin/usage/range missing params → 400", async () => {
    const res = await adminRouter(makeReq("/admin/usage/range"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body).toHaveProperty("error");
  });

  test("GET /admin/stats → 200 with total_requests", async () => {
    const res = await adminRouter(makeReq("/admin/stats"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body).toHaveProperty("total_requests", 100);
  });

  test("GET /admin/logs?limit=5&offset=0 → 200 array", async () => {
    const res = await adminRouter(makeReq("/admin/logs?limit=5&offset=0"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /admin/logs/1 → 404 when not found", async () => {
    const res = await adminRouter(makeReq("/admin/logs/1"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  test("non-GET request → null (not handled)", async () => {
    const res = await adminRouter(makeReq("/admin/stats", "POST"));
    expect(res).toBeNull();
  });
});
