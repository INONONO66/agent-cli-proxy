import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";

type StorageModule = typeof import("../../src/storage/db");
type ServiceModule = typeof import("../../src/storage/service");
type HandlerModule = typeof import("../../src/server/handler");

const ADMIN_TOKEN = "admin-date-range-token";

let storageModule: StorageModule;
let serviceModule: ServiceModule;
let handlerModule: HandlerModule;
let db: Database;
let handleRequest: (req: Request, context?: LocalTestContext) => Promise<Response>;

type LocalTestContext = {
  requestIP(req: Request): { address: string; port: number; family: "IPv4" | "IPv6" } | null;
};

describe("admin date query validation", () => {
  beforeAll(async () => {
    process.env.PROXY_LOCAL_OK = "1";
    storageModule = await import("../../src/storage/db");
    serviceModule = await import("../../src/storage/service");
    handlerModule = await import("../../src/server/handler");
  });

  beforeEach(() => {
    db = storageModule.Storage.initDb(":memory:");
    handleRequest = handlerModule.Handler.create(serviceModule.UsageService.create(db), {
      securityConfig: {
        adminApiKey: ADMIN_TOKEN,
        host: "0.0.0.0",
        proxyRequireApiKey: true,
        trustProxyHeaders: false,
      },
    });
  });

  it("rejects malformed usage range dates", async () => {
    const res = await adminGet("/admin/usage/range?from=invalid&to=also-bad");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Invalid from parameter; expected YYYY-MM-DD",
    });
  });

  it("rejects reversed usage ranges", async () => {
    const res = await adminGet("/admin/usage/range?from=2026-12-01&to=2026-01-01");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "from must be on or before to",
    });
  });

  it("rejects ranges wider than one year", async () => {
    const res = await adminGet("/admin/usage/accounts/summary?from=2024-01-01&to=2026-01-02");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Date range cannot exceed 366 days",
    });
  });

  it("rejects partial model and provider ranges", async () => {
    for (const path of [
      "/admin/usage/models?from=2026-01-01",
      "/admin/usage/models?to=2026-01-31",
      "/admin/usage/providers?from=2026-01-01",
      "/admin/usage/providers?to=2026-01-31",
    ]) {
      const res = await adminGet(path);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "Both from and to are required when using date range",
      });
    }
  });

  it("accepts valid account summary ranges", async () => {
    const res = await adminGet("/admin/usage/accounts/summary?from=2026-01-01&to=2026-01-31");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

function adminGet(path: string): Promise<Response> {
  return handleRequest(new Request(`http://127.0.0.1:3100${path}`, {
    headers: { "x-admin-token": ADMIN_TOKEN },
  }), localContext());
}

function localContext() {
  return { requestIP: () => ({ address: "127.0.0.1", port: 54321, family: "IPv4" as const }) };
}
