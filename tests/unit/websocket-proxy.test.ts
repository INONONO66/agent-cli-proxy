import { expect, test } from "bun:test";

test("websocket proxy relays messages and masks client credentials upstream", async () => {
  await runIsolatedCheck(`
    const seenHeaders = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        const headers = new Headers(req.headers);
        seenHeaders.push(headers);
        if (server.upgrade(req, { data: { headers } })) return;
        return new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message(ws, message) {
          ws.send(typeof message === "string" ? "echo:" + message : message);
        },
      },
    });

    process.env.CLI_PROXY_API_URL = "http://127.0.0.1:" + upstream.port;
    process.env.PROXY_REQUIRE_API_KEY = "false";

    const { Storage } = await import("./src/storage/db.ts");
    const { UsageService } = await import("./src/storage/service.ts");
    const { Handler } = await import("./src/server/handler.ts");
    const { WebSocketProxy } = await import("./src/server/websocket-proxy.ts");

    const db = Storage.initDb(":memory:");
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: Handler.create(UsageService.create(db)),
      websocket: WebSocketProxy.handler,
    });

    try {
      const ws = await connect("ws://127.0.0.1:" + proxy.port + "/v1/realtime?model=gpt-4o", {
        headers: {
          authorization: "Bearer client-secret",
          "x-api-key": "client-x-api-key",
        },
      });
      const reply = await roundTrip(ws, "hello");

      assert(reply === "echo:hello", "expected websocket echo reply");
      assert(seenHeaders.length === 1, "expected one upstream upgrade");
      assert(seenHeaders[0].get("authorization") === "Bearer proxy", "expected upstream proxy auth");
      assert(seenHeaders[0].get("x-api-key") === null, "client x-api-key leaked upstream");
      assert(seenHeaders[0].get("x-forwarded-for") === null, "spoofable forwarded header leaked upstream");
      ws.close();
    } finally {
      proxy.stop(true);
      upstream.stop(true);
      db.close();
    }
  `);
});

test("websocket upgrade requires managed proxy key in public mode", async () => {
  await runIsolatedCheck(`
    const { Storage } = await import("./src/storage/db.ts");
    const { UsageService } = await import("./src/storage/service.ts");
    const { ApiKeyRepo } = await import("./src/storage/api-keys.ts");
    const { Handler } = await import("./src/server/handler.ts");

    const db = Storage.initDb(":memory:");
    const handle = Handler.create(UsageService.create(db), {
      securityConfig: { host: "0.0.0.0", adminApiKey: "admin-token", proxyRequireApiKey: true },
    });
    try {
      const missing = await handle(new Request("http://proxy.test/v1/realtime", {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
        },
      }));
      assert(missing.status === 401, "missing managed key should be rejected");

      const apiKey = await ApiKeyRepo.create(db, "ws-client");
      const acceptedWithoutServer = await handle(new Request("http://proxy.test/v1/realtime", {
        headers: {
          authorization: "Bearer " + apiKey.key,
          connection: "Upgrade",
          upgrade: "websocket",
        },
      }));
      assert(acceptedWithoutServer.status === 501, "valid key should reach upgrade handling");
      const touched = ApiKeyRepo.list(db).find((key) => key.id === apiKey.id);
      assert(typeof touched?.lastUsedAt === "string", "valid websocket key should update last_used_at");
    } finally {
      db.close();
    }
  `, { PROXY_REQUIRE_API_KEY: "true", PROXY_HOST: "0.0.0.0", ADMIN_API_KEY: "admin-token" });
});

async function runIsolatedCheck(check: string, env: Record<string, string> = {}): Promise<void> {
  const script = `
    process.env.PROXY_LOCAL_OK = "1";
    process.env.LOG_LEVEL = "error";
    process.env.DB_PATH = "/tmp/agent-cli-proxy-ws-test-" + crypto.randomUUID() + ".db";
    process.env.PRICING_CACHE_PATH = "/tmp/agent-cli-proxy-ws-test-pricing-" + crypto.randomUUID() + ".json";
    ${Object.entries(env).map(([key, value]) => `process.env.${key} = ${JSON.stringify(value)};`).join("\n")}
    function assert(condition, message) {
      if (!condition) throw new Error(message);
    }
    function connect(url, options) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, options);
        const timer = setTimeout(() => reject(new Error("websocket open timed out")), 1_000);
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          resolve(ws);
        }, { once: true });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("websocket open failed"));
        }, { once: true });
      });
    }
    function roundTrip(ws, message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("websocket message timed out")), 1_000);
        ws.addEventListener("message", (event) => {
          clearTimeout(timer);
          resolve(String(event.data));
        }, { once: true });
        ws.send(message);
      });
    }
    ${check}
  `;
  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, PROXY_LOCAL_OK: "1", LOG_LEVEL: "error", PLANS_JSON: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(`${stdoutText}${stderrText}`).toBe("");
  expect(exitCode).toBe(0);
}
