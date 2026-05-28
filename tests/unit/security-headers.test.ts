import { describe, expect, test } from "bun:test";

describe("security headers and proxy headers", () => {
  test("adds baseline security headers to dashboard redirects", async () => {
    await runIsolatedCheck(`
      const res = await handle(new Request("http://proxy.test/dashboard"));
      assert(res.status === 302, "expected dashboard redirect");
      assert(res.headers.get("location") === "/dashboard/", "expected dashboard redirect location");
      assert(res.headers.get("x-frame-options") === "DENY", "missing X-Frame-Options");
      assert(res.headers.get("x-content-type-options") === "nosniff", "missing X-Content-Type-Options");
      assert(res.headers.get("referrer-policy") === "strict-origin-when-cross-origin", "missing Referrer-Policy");
      assert(res.headers.get("permissions-policy") === "camera=(), microphone=(), geolocation=()", "missing Permissions-Policy");
      assert(res.headers.get("cross-origin-opener-policy") === "same-origin", "missing Cross-Origin-Opener-Policy");
      assert(res.headers.get("x-permitted-cross-domain-policies") === "none", "missing X-Permitted-Cross-Domain-Policies");
    `);
  });

  test("does not emit HSTS from bind host or untrusted forwarded headers", async () => {
    await runIsolatedCheck(`
      const res = await handle(new Request("http://proxy.test/health", {
        headers: {
          "x-forwarded-proto": "https",
          "cf-visitor": JSON.stringify({ scheme: "https" }),
        },
      }));
      assert(res.status === 200, "expected health response");
      assert(res.headers.get("strict-transport-security") === null, "HSTS must not trust proxy headers by default");
    `, { PROXY_HOST: "0.0.0.0", ADMIN_API_KEY: "admin-token" });
  });

  test("emits HSTS only when HTTPS is known directly or via explicitly trusted proxy headers", async () => {
    await runIsolatedCheck(`
      const direct = await handle(new Request("https://proxy.test/health"));
      assert(direct.headers.get("strict-transport-security") === "max-age=31536000; includeSubDomains", "direct HTTPS should emit HSTS");

      const forwarded = await handle(new Request("http://proxy.test/health", {
        headers: { "x-forwarded-proto": "https" },
      }));
      assert(forwarded.headers.get("strict-transport-security") === "max-age=31536000; includeSubDomains", "trusted forwarded HTTPS should emit HSTS");
    `, { TRUST_PROXY_HEADERS: "true" });
  });

  test("dashboard login Secure cookie only trusts forwarded proto when configured", async () => {
    const passwordHash = await Bun.password.hash("secret-password");

    await runIsolatedCheck(`
      const res = await handle(new Request("http://proxy.test/admin/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
        },
        body: JSON.stringify({ password: "secret-password" }),
      }));
      assert(res.status === 200, "expected login to succeed");
      const cookie = res.headers.get("set-cookie") ?? "";
      assert(cookie.includes("HttpOnly"), "expected session cookie");
      assert(!cookie.includes("Secure"), "untrusted forwarded proto must not set Secure cookie");
    `, { DASHBOARD_PASSWORD_HASH: passwordHash, DASHBOARD_SESSION_SECRET: "test-session-secret" });

    await runIsolatedCheck(`
      const res = await handle(new Request("http://proxy.test/admin/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
        },
        body: JSON.stringify({ password: "secret-password" }),
      }));
      assert(res.status === 200, "expected login to succeed");
      const cookie = res.headers.get("set-cookie") ?? "";
      assert(cookie.includes("Secure"), "trusted forwarded proto should set Secure cookie");
    `, { TRUST_PROXY_HEADERS: "true", DASHBOARD_PASSWORD_HASH: passwordHash, DASHBOARD_SESSION_SECRET: "test-session-secret" });
  });


  test("marks missing proxy API key JSON failures as no-store", async () => {
    await runIsolatedCheck(`
      const res = await handle(new Request("http://proxy.test/v1/models"));
      assert(res.status === 401, "expected missing proxy key to be rejected");
      assert(res.headers.get("content-type").includes("application/json"), "expected JSON error");
      assert(res.headers.get("cache-control") === "no-store", "missing no-store on proxy auth error");
    `, { PROXY_REQUIRE_API_KEY: "true" });
  });

  test("adds baseline security headers to proxied API responses", async () => {
    await runIsolatedProxyCheck();
  });
});

async function runIsolatedCheck(check: string, env: Record<string, string> = {}): Promise<void> {
  const script = `
    process.env.PROXY_LOCAL_OK = "1";
    process.env.LOG_LEVEL = "error";
    ${Object.entries(env).map(([key, value]) => `process.env.${key} = ${JSON.stringify(value)};`).join("\n")}
    const { Handler } = await import("./src/server/handler.ts");
    const { Storage } = await import("./src/storage/db.ts");
    const { UsageService } = await import("./src/storage/service.ts");
    const db = Storage.initDb(":memory:");
    const handle = Handler.create(UsageService.create(db));
    function assert(condition, message) {
      if (!condition) throw new Error(message);
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

async function runIsolatedProxyCheck(): Promise<void> {
  const script = `
    process.env.PROXY_LOCAL_OK = "1";
    process.env.LOG_LEVEL = "error";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    process.env.CLI_PROXY_API_URL = "http://127.0.0.1:" + upstream.port;
    const { Handler } = await import("./src/server/handler.ts");
    const { Storage } = await import("./src/storage/db.ts");
    const { UsageService } = await import("./src/storage/service.ts");
    const db = Storage.initDb(":memory:");
    const handle = Handler.create(UsageService.create(db));
    try {
      const res = await handle(new Request("http://proxy.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "opencode/1.0" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }));
      if (res.status !== 200) throw new Error("expected proxied response");
      if (res.headers.get("x-frame-options") !== "DENY") throw new Error("missing X-Frame-Options");
      if (res.headers.get("x-content-type-options") !== "nosniff") throw new Error("missing X-Content-Type-Options");
      if (res.headers.get("referrer-policy") !== "strict-origin-when-cross-origin") throw new Error("missing Referrer-Policy");
      if (res.headers.get("cross-origin-opener-policy") !== "same-origin") throw new Error("missing Cross-Origin-Opener-Policy");
      await res.text();
    } finally {
      upstream.stop(true);
      db.close();
    }
  `;
  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, PROXY_LOCAL_OK: "1", LOG_LEVEL: "error", PLANS_JSON: "" },
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
