import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";

type StorageModule = typeof import("../../src/storage/db");
type ServiceModule = typeof import("../../src/storage/service");
type HandlerModule = typeof import("../../src/server/handler");

const ADMIN_TOKEN = "admin-auth-token";
const SESSION_SECRET = "admin-auth-session-secret";
const PASSWORD = "correct horse battery staple";

let storageModule: StorageModule;
let serviceModule: ServiceModule;
let handlerModule: HandlerModule;
let db: Database;
let handleRequest: (req: Request, context?: LocalTestContext) => Promise<Response>;
let passwordHash: string;
const envSnapshot = new Map<string, string | undefined>();

type LocalTestContext = {
  requestIP(req: Request): { address: string; port: number; family: "IPv4" | "IPv6" } | null;
};

function setEnv(key: string, value: string | undefined): void {
  if (!envSnapshot.has(key)) envSnapshot.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("admin auth and deployment security", () => {
  beforeAll(async () => {
    setEnv("PROXY_LOCAL_OK", "1");
    setEnv("PROXY_HOST", "0.0.0.0");
    setEnv("ADMIN_API_KEY", ADMIN_TOKEN);
    setEnv("TRUST_PROXY_HEADERS", undefined);

    passwordHash = await Bun.password.hash(PASSWORD);
    storageModule = await import("../../src/storage/db");
    serviceModule = await import("../../src/storage/service");
    handlerModule = await import("../../src/server/handler");
  });

  afterAll(() => {
    for (const [key, value] of envSnapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    envSnapshot.clear();
  });

  beforeEach(() => {
    db = storageModule.Storage.initDb(":memory:");
    handleRequest = handlerModule.Handler.create(serviceModule.UsageService.create(db), {
      sessionConfig: {
        passwordHash,
        secret: SESSION_SECRET,
        ttlMs: 60_000,
      },
      securityConfig: {
        adminApiKey: ADMIN_TOKEN,
        host: "0.0.0.0",
        proxyRequireApiKey: true,
        trustProxyHeaders: false,
      },
    });
  });

  it("allows token-authenticated admin mutations without CSRF while preserving cookie CSRF", async () => {
    const tokenRes = await createApiKey({
      "x-admin-token": ADMIN_TOKEN,
    }, "token-key");

    expect(tokenRes.status).toBe(201);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");

    const cookie = await loginCookie();
    const missingCsrfRes = await createApiKey({
      cookie,
    }, "cookie-no-csrf");
    expect(missingCsrfRes.status).toBe(403);
    expect(missingCsrfRes.headers.get("cache-control")).toBe("no-store");
    expect(await missingCsrfRes.json()).toMatchObject({ code: "CSRF_REQUIRED" });

    const csrfRes = await createApiKey({
      cookie,
      "x-csrf": "1",
    }, "cookie-with-csrf");
    expect(csrfRes.status).toBe(201);
  });

  it("marks unauthenticated admin JSON failures as no-store", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:3100/admin/usage/today"), localContext());

    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("does not emit HSTS for plain HTTP solely because host is non-loopback", async () => {
    const res = await handleRequest(new Request("http://127.0.0.1:3100/health", {
      headers: {
        "x-forwarded-proto": "https",
        "cf-visitor": "{\"scheme\":\"https\"}",
      },
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("emits HSTS when the request URL is directly HTTPS", async () => {
    const res = await handleRequest(new Request("https://proxy.example.test/health"));

    expect(res.status).toBe(200);
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
  });

  it("honors forwarded proto only behind explicit proxy-trust config", async () => {
    const trustedHandle = handlerModule.Handler.create(serviceModule.UsageService.create(db), {
      securityConfig: {
        adminApiKey: ADMIN_TOKEN,
        host: "0.0.0.0",
        proxyRequireApiKey: true,
        trustProxyHeaders: true,
      },
    });
    const res = await trustedHandle(new Request("http://127.0.0.1:3100/health", {
      headers: { "x-forwarded-proto": "https" },
    }));

    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
  });

  it("uses handler proxy-trust config consistently for session Secure cookies", async () => {
    const trustedHandle = handlerModule.Handler.create(serviceModule.UsageService.create(db), {
      sessionConfig: {
        passwordHash,
        secret: SESSION_SECRET,
        ttlMs: 60_000,
      },
      securityConfig: {
        adminApiKey: ADMIN_TOKEN,
        host: "0.0.0.0",
        proxyRequireApiKey: true,
        trustProxyHeaders: true,
      },
    });

    const res = await trustedHandle(new Request("http://127.0.0.1:3100/admin/session/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ password: PASSWORD }),
    }), localContext());

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("keeps metrics local-only even when admin token is valid", async () => {
    const remote = await handlerModule.Handler.create(serviceModule.UsageService.create(db), {
      securityConfig: { adminApiKey: ADMIN_TOKEN, host: "0.0.0.0", proxyRequireApiKey: true, trustProxyHeaders: false },
    })(new Request("http://proxy.example.test/metrics", {
      headers: { "x-admin-token": ADMIN_TOKEN },
    }), remoteContext());
    expect(remote.status).toBe(403);
    expect(remote.headers.get("cache-control")).toBe("no-store");
    expect(await remote.json()).toMatchObject({ code: "LOCAL_ONLY" });

    const local = await handlerModule.Handler.create(serviceModule.UsageService.create(db), {
      securityConfig: { adminApiKey: ADMIN_TOKEN, host: "0.0.0.0", proxyRequireApiKey: true, trustProxyHeaders: false },
    })(new Request("http://127.0.0.1:3100/metrics", {
      headers: { "x-admin-token": ADMIN_TOKEN },
    }), localContext());
    expect(local.status).toBe(200);
    expect(local.headers.get("content-type")).toContain("text/plain");
  });

  it("keeps admin APIs local-only even when admin token is valid", async () => {
    const res = await handleRequest(new Request("http://proxy.example.test/admin/usage/today", {
      headers: { "x-admin-token": ADMIN_TOKEN },
    }), remoteContext());

    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ code: "LOCAL_ONLY" });
  });

  it("rejects handler security overrides that disable proxy keys off loopback", () => {
    expect(() => handlerModule.Handler.create(serviceModule.UsageService.create(db), {
      securityConfig: {
        adminApiKey: ADMIN_TOKEN,
        host: "0.0.0.0",
        proxyRequireApiKey: false,
        trustProxyHeaders: false,
      },
    })).toThrow("PROXY_REQUIRE_API_KEY must be true when PROXY_HOST is not loopback");
  });
});

async function loginCookie(): Promise<string> {
  const res = await handleRequest(new Request("http://127.0.0.1:3100/admin/session/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  }), localContext());
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("login did not set cookie");
  return setCookie.split(";")[0];
}

function createApiKey(headers: Record<string, string>, name: string): Promise<Response> {
  return handleRequest(new Request("http://127.0.0.1:3100/admin/api-keys", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ name }),
  }), localContext());
}

function localContext() {
  return { requestIP: () => ({ address: "127.0.0.1", port: 54321, family: "IPv4" as const }) };
}

function remoteContext() {
  return { requestIP: () => ({ address: "203.0.113.10", port: 54321, family: "IPv4" as const }) };
}
