import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";

type StorageModule = typeof import("../../src/storage/db");
type ServiceModule = typeof import("../../src/storage/service");
type HandlerModule = typeof import("../../src/server/handler");

const ADMIN_TOKEN = "admin-filter-validation-token";

let storageModule: StorageModule;
let serviceModule: ServiceModule;
let handlerModule: HandlerModule;
let db: Database;
let handleRequest: (req: Request, context?: LocalTestContext) => Promise<Response>;

type LocalTestContext = {
  requestIP(req: Request): { address: string; port: number; family: "IPv4" | "IPv6" } | null;
};

describe("admin filter validation", () => {
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

  it("rejects empty admin log filter values", async () => {
    for (const path of [
      "/admin/logs?tool=",
      "/admin/logs?tool=%20%20",
      "/admin/logs?client_id=",
      "/admin/logs?client_id=%20%20",
    ]) {
      const res = await adminGet(path);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "Invalid filter parameter",
      });
    }
  });

  it("accepts non-empty admin log filter values", async () => {
    const res = await adminGet("/admin/logs?tool=opencode&client_id=desktop");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("accepts absent admin log filters", async () => {
    const res = await adminGet("/admin/logs");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("rejects admin log offsets above the scan cap", async () => {
    const res = await adminGet("/admin/logs?offset=100001");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Invalid limit or offset",
    });
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
